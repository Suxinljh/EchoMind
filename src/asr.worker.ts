import { createOnlineRecognizer, initASRModule, type OnlineRecognizer, type OnlineStream } from '@sherpaw/asr'
import { loadVirtualData } from '@sherpaw/preloader'

let recognizer: OnlineRecognizer | null = null
let stream: OnlineStream | null = null
let completed: string[] = []
let partial = ''
let resampleTail = new Float32Array(0)
let resamplePosition = 0
// 「重新转写」需要保留整段录音。上限对齐 docs/HANDOFF.md 的连续录音目标，
// 并用 Int16 定点化把常驻内存减半（20 分钟约 38 MB）；越界后停止入队并标记截断。
const SAMPLE_RATE = 16000
const MAX_BUFFER_SECONDS = 1200
const MAX_BUFFER_SAMPLES = MAX_BUFFER_SECONDS * SAMPLE_RATE
const TRANSCRIPT_INTERVAL_MS = 400

let recorded: Int16Array[] = []
let bufferedSamples = 0
let bufferedTruncated = false
let processedFrames = 0
let lastProgressSecond = -1
let lastTranscriptAt = 0
let endpointPending = false

function emit(type: string, extra: Record<string, unknown> = {}) { self.postMessage({ type, ...extra }) }
function emitTranscript() {
  lastTranscriptAt = Date.now()
  endpointPending = false
  emit('transcript', { final: completed.join(' '), interim: partial, segments: [...completed] })
}
function drain() {
  if (!recognizer || !stream) return
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  partial = String(recognizer.getResult(stream).text || '')
  if (recognizer.isEndpoint(stream)) {
    if (partial) completed.push(partial)
    partial = ''
    recognizer.reset(stream)
    endpointPending = true
  }
  // 每个音频块都回传 transcript 会让主线程以约 23 Hz 重渲染整棵树；限流到 400 ms，翻页与收尾仍然必发。
  if (endpointPending || Date.now() - lastTranscriptAt >= TRANSCRIPT_INTERVAL_MS) emitTranscript()
}
function store(samples: Float32Array) {
  const room = MAX_BUFFER_SAMPLES - bufferedSamples
  if (room <= 0) { bufferedTruncated = true; return }
  const slice = samples.length > room ? samples.subarray(0, room) : samples
  const quantized = new Int16Array(slice.length)
  for (let i = 0; i < slice.length; i += 1) {
    const value = slice[i]
    quantized[i] = value >= 1 ? 32767 : value <= -1 ? -32768 : Math.round(value * 32767)
  }
  recorded.push(quantized)
  bufferedSamples += quantized.length
  if (bufferedSamples >= MAX_BUFFER_SAMPLES) bufferedTruncated = true
}
function releaseBuffer() { recorded = []; bufferedSamples = 0; bufferedTruncated = false }
function* bufferedFloatChunks(): Generator<Float32Array> {
  for (const chunk of recorded) {
    const floats = new Float32Array(chunk.length)
    for (let i = 0; i < chunk.length; i += 1) floats[i] = chunk[i] / 32767
    yield floats
  }
}
function finishStream(truncated = false) {
  if (!stream || !recognizer) return
  stream.acceptWaveform(SAMPLE_RATE, new Float32Array(SAMPLE_RATE))
  stream.inputFinished(); drain()
  const segments = [...completed, partial].filter(Boolean)
  emit('finished', { text: segments.join(' '), segments, processedSeconds: processedFrames / SAMPLE_RATE, truncated })
  stream.free(); stream = null
}
function resample(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === SAMPLE_RATE) return input
  const combined = new Float32Array(resampleTail.length + input.length)
  combined.set(resampleTail); combined.set(input, resampleTail.length)
  const step = sourceRate / SAMPLE_RATE
  const output: number[] = []
  while (resamplePosition + 1 < combined.length) {
    const i = Math.floor(resamplePosition); const fraction = resamplePosition - i
    output.push(combined[i] * (1 - fraction) + combined[i + 1] * fraction)
    resamplePosition += step
  }
  const consumed = Math.floor(resamplePosition)
  resampleTail = combined.slice(consumed)
  resamplePosition -= consumed
  return Float32Array.from(output)
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data
  try {
    if (message.type === 'init') {
      emit('loading', { detail: '加载浏览器语音引擎' })
      const module = await initASRModule()
      const files = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
      const buffers: Record<string, ArrayBuffer> = {}
      for (const name of files) {
        emit('loading', { detail: `读取 ${name}` })
        const response = await fetch(`/models/zipformer-2025/${name}`)
        if (!response.ok) throw new Error(`无法读取本地模型 ${name}`)
        buffers[name] = await response.arrayBuffer()
      }
      loadVirtualData({ module, virtualData: buffers })
      recognizer = createOnlineRecognizer(module, { modelConfig: { numThreads: 1, debug: 0 } })
      emit('ready')
    } else if (message.type === 'start') {
      if (!recognizer) throw new Error('语音模型尚未就绪')
      stream?.free(); stream = recognizer.createStream()
      completed = []; partial = ''; resampleTail = new Float32Array(0); resamplePosition = 0; processedFrames = 0; lastProgressSecond = -1
      releaseBuffer()
      emitTranscript()
    } else if (message.type === 'audio' && stream && recognizer) {
      const input = message.samples as Float32Array
      const samples = resample(input, message.sampleRate)
      if (samples.length) { store(samples); processedFrames += samples.length; stream.acceptWaveform(SAMPLE_RATE, samples) }
      drain()
      const second = Math.floor(processedFrames / SAMPLE_RATE)
      if (second !== lastProgressSecond) { lastProgressSecond = second; emit('progress', { processedSeconds: processedFrames / SAMPLE_RATE, bufferedSeconds: bufferedSamples / SAMPLE_RATE, bufferedTruncated }) }
    } else if (message.type === 'finish') {
      // 会话已经结束（例如录音过程中切换了练习）时不能再静默忽略，否则主线程的 finish() 永远不会兑现。
      if (stream && recognizer) finishStream()
      else emit('error', { detail: '录音会话已结束，无法收尾转写。' })
    } else if (message.type === 'replay') {
      if (!recognizer) {
        emit('error', { detail: '语音模型尚未就绪，无法重新转写。' })
      } else if (!recorded.length) {
        emit('finished', { text: '', segments: [], processedSeconds: 0, truncated: false })
      } else {
        stream?.free(); stream = recognizer.createStream(); completed = []; partial = ''
        emitTranscript()
        // Replay in larger batches to reduce per-message overhead on slower Macs.
        const batch = new Float32Array(8000)
        let used = 0
        for (const chunk of bufferedFloatChunks()) {
          let offset = 0
          while (offset < chunk.length) {
            const count = Math.min(batch.length - used, chunk.length - offset)
            batch.set(chunk.subarray(offset, offset + count), used)
            used += count; offset += count
            if (used === batch.length) { stream.acceptWaveform(SAMPLE_RATE, batch); drain(); used = 0 }
          }
        }
        if (used) { stream.acceptWaveform(SAMPLE_RATE, batch.slice(0, used)); drain() }
        finishStream(bufferedTruncated)
      }
    } else if (message.type === 'reset') {
      // 回答已确认，缓冲区不再需要；立即释放内存而不必等到下一次录音。
      releaseBuffer()
    }
  } catch (error) { emit('error', { detail: error instanceof Error ? error.message : String(error) }) }
}
