import { createOnlineRecognizer, initASRModule, type OnlineRecognizer, type OnlineStream } from '@sherpaw/asr'
import { loadVirtualData } from '@sherpaw/preloader'

let recognizer: OnlineRecognizer | null = null
let stream: OnlineStream | null = null
let completed: string[] = []
let partial = ''
let resampleTail = new Float32Array(0)
let resamplePosition = 0
let recorded: Float32Array[] = []
let processedFrames = 0
let lastProgressSecond = -1

function emit(type: string, extra: Record<string, unknown> = {}) { self.postMessage({ type, ...extra }) }
function drain() {
  if (!recognizer || !stream) return
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  partial = String(recognizer.getResult(stream).text || '')
  if (recognizer.isEndpoint(stream)) {
    if (partial) completed.push(partial)
    partial = ''
    recognizer.reset(stream)
  }
  emit('transcript', { final: completed.join(' '), interim: partial, segments: [...completed] })
}
function finishStream() {
  if (!stream || !recognizer) return
  stream.acceptWaveform(16000, new Float32Array(16000))
  stream.inputFinished(); drain()
  emit('finished', { text: [...completed, partial].filter(Boolean).join(' '), segments: [...completed, partial].filter(Boolean), processedSeconds: processedFrames / 16000 })
  stream.free(); stream = null
}
function resample(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16000) return input
  const combined = new Float32Array(resampleTail.length + input.length)
  combined.set(resampleTail); combined.set(input, resampleTail.length)
  const step = sourceRate / 16000
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
      completed = []; partial = ''; resampleTail = new Float32Array(0); resamplePosition = 0; recorded = []; processedFrames = 0; lastProgressSecond = -1
      emit('transcript', { final: '', interim: '', segments: [] })
    } else if (message.type === 'audio' && stream && recognizer) {
      const input = message.samples as Float32Array
      const samples = resample(input, message.sampleRate)
      if (samples.length) { recorded.push(samples); processedFrames += samples.length; stream.acceptWaveform(16000, samples) }
      drain()
      const second = Math.floor(processedFrames / 16000)
      if (second !== lastProgressSecond) { lastProgressSecond = second; emit('progress', { processedSeconds: processedFrames / 16000 }) }
    } else if (message.type === 'finish' && stream && recognizer) {
      finishStream()
    } else if (message.type === 'replay' && recognizer && !recorded.length) {
      emit('finished', { text: '', segments: [], processedSeconds: 0 })
    } else if (message.type === 'replay' && recognizer && recorded.length) {
      stream?.free(); stream = recognizer.createStream(); completed = []; partial = ''
      emit('transcript', { final: '', interim: '', segments: [] })
      // Replay in larger batches to reduce per-message overhead on slower Macs.
      const batch = new Float32Array(8000)
      let used = 0
      for (const chunk of recorded) {
        let offset = 0
        while (offset < chunk.length) {
          const count = Math.min(batch.length - used, chunk.length - offset)
          batch.set(chunk.subarray(offset, offset + count), used)
          used += count; offset += count
          if (used === batch.length) { stream.acceptWaveform(16000, batch); drain(); used = 0 }
        }
      }
      if (used) { stream.acceptWaveform(16000, batch.slice(0, used)); drain() }
      finishStream()
    }
  } catch (error) { emit('error', { detail: error instanceof Error ? error.message : String(error) }) }
}
