import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechEvent } from './types'
import { readMicrophonePreference } from './microphonePreference'

type RecorderStatus = 'loading' | 'ready' | 'recording' | 'paused' | 'finishing' | 'error'

// 收尾与重新转写必须最终兑现，否则界面会永久停在「正在收尾转写…」。
const FINISH_TIMEOUT_MS = 15000
// 重新转写要重新解码整段录音，长录音稳定超过 15 秒；按 20 分钟缓冲上限给足时间。
// 即便仍然超时，App 也会用后续到达的最终结果更新待确认回答。
const REPLAY_TIMEOUT_MS = 10 * 60_000
// 输入电平与时长只用于展示，合并提交以降低录音期间的渲染频率。
const DISPLAY_INTERVAL_MS = 100

export function useRecorder(enabled: boolean) {
  const [status, setStatus] = useState<RecorderStatus>('loading')
  const [detail, setDetail] = useState('准备语音模型')
  const [captureError, setCaptureError] = useState('')
  const [recorderNotice, setRecorderNotice] = useState('')
  const [final, setFinal] = useState('')
  const [interim, setInterim] = useState('')
  const [segments, setSegments] = useState<string[]>([])
  // 每次收到最终转写都自增；收尾超时后仍可用它把迟到的结果合并回待确认回答。
  const [finishedSeq, setFinishedSeq] = useState(0)
  // 收尾/重转写超时后给出提示，但保持 finishing 以免在 worker 仍忙时开始新录音。
  const [finishTimedOut, setFinishTimedOut] = useState(false)
  const [duration, setDuration] = useState(0)
  const [events, setEvents] = useState<SpeechEvent[]>([])
  const [silenceHint, setSilenceHint] = useState(false)
  const [inputLevel, setInputLevel] = useState(0)
  const [peakLevel, setPeakLevel] = useState(0)
  const [signalWarning, setSignalWarning] = useState(false)
  const [processedSeconds, setProcessedSeconds] = useState(0)
  const [microphone, setMicrophone] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceIdState] = useState(() => readMicrophonePreference().id)
  const [deviceBusy, setDeviceBusy] = useState(false)
  // 切换练习或录音异常时重建 worker，丢弃旧录音可能迟到的工作线程消息。
  const [workerNonce, setWorkerNonce] = useState(0)
  const deviceBusyRef = useRef(false)
  const worker = useRef<Worker | null>(null)
  // 重建 worker 前丢弃旧 worker 可能还在路上的消息，避免旧录音写进新练习。
  const discardMessages = useRef(false)
  const audio = useRef<{ context: AudioContext; source: MediaStreamAudioSourceNode; node: AudioWorkletNode; stream: MediaStream } | null>(null)
  const statusRef = useRef<RecorderStatus>('loading')
  const activeTime = useRef(0)
  const silenceStart = useRef<number | null>(null)
  const finishResolve = useRef<((text: string) => void) | null>(null)
  const finalRef = useRef('')
  const interimRef = useRef('')
  const segmentsRef = useRef<string[]>([])
  const eventsRef = useRef<SpeechEvent[]>([])
  const deviceIdRef = useRef(readMicrophonePreference().id)
  const peakRef = useRef(0)
  const noSignalSeconds = useRef(0)
  const displayTimer = useRef<number | null>(null)
  const displayPending = useRef<{ duration: number; level: number; peak: number } | null>(null)

  function changeStatus(next: RecorderStatus) { statusRef.current = next; setStatus(next) }
  // 单独读取，避免收尾函数里的类型收窄让 statusRef 的比较被误判。
  function statusIsError() { return statusRef.current === 'error' }
  function addEvent(item: SpeechEvent) { eventsRef.current = [...eventsRef.current, item]; setEvents(eventsRef.current) }
  function closeSilence(end: number) {
    const start = silenceStart.current
    if (start !== null && end - start >= 1) addEvent({ kind: 'silence', start, end, source: 'audio-rms' })
    silenceStart.current = null; setSilenceHint(false)
  }

  function flushDisplay() {
    displayTimer.current = null
    const value = displayPending.current
    if (!value) return
    displayPending.current = null
    setDuration(value.duration); setInputLevel(value.level); setPeakLevel(value.peak)
  }
  function queueDisplay(value: { duration: number; level: number; peak: number }) {
    displayPending.current = value
    if (displayTimer.current !== null) return
    displayTimer.current = window.setTimeout(flushDisplay, DISPLAY_INTERVAL_MS)
  }
  // 先停止音轨，确保即使节点断开抛错也不会继续占用麦克风。
  function releaseAudio() {
    const current = audio.current
    audio.current = null
    if (!current) return
    current.stream.getTracks().forEach(track => track.stop())
    try { current.node.disconnect() } catch { /* 节点可能已断开。 */ }
    try { current.source.disconnect() } catch { /* 节点可能已断开。 */ }
    void current.context.close().catch(() => {})
  }
  // 收尾或重新转写期间的故障要兑现挂起的 Promise 并回到可用状态。
  function failWorker(message: string) {
    setDetail(message)
    releaseAudio()
    const pendingFinish = finishResolve.current
    finishResolve.current = null
    if (pendingFinish) {
      setRecorderNotice(message)
      pendingFinish(finalRef.current + interimRef.current)
      setFinishTimedOut(false)
      // worker 已出错时不要再回到 ready，避免用户在失效的 worker 上开始新录音。
      changeStatus('error')
      return
    }
    // 录音中工作线程崩溃：释放麦克风，不能让它一直采集。
    if (displayTimer.current !== null) { window.clearTimeout(displayTimer.current); displayTimer.current = null; displayPending.current = null }
    silenceStart.current = null
    setInputLevel(0); setPeakLevel(0); setSignalWarning(false); setSilenceHint(false); setFinishTimedOut(false)
    changeStatus('error')
  }
  function awaitTranscript(message: { type: string }, timeoutMs = FINISH_TIMEOUT_MS) {
    return new Promise<string>(resolve => {
      let settled = false
      let timer: number | null = null
      const done = (text: string) => {
        if (settled) return
        settled = true
        if (timer !== null) window.clearTimeout(timer)
        if (finishResolve.current === done) finishResolve.current = null
        resolve(text)
      }
      finishResolve.current = done
      timer = window.setTimeout(() => {
        setFinishTimedOut(true)
        done(finalRef.current + interimRef.current)
      }, timeoutMs)
      // worker 已经退出时不要白等超时；postMessage 失败也要立即兑现。
      if (!worker.current) { done(finalRef.current + interimRef.current); return }
      try { worker.current.postMessage(message) } catch { done(finalRef.current + interimRef.current) }
    })
  }

  useEffect(() => {
    if (!enabled) return
    discardMessages.current = false
    const refresh = () => { void navigator.mediaDevices.enumerateDevices().then(list => setDevices(list.filter(d => d.kind === 'audioinput'))).catch(() => {}) }
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    const w = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onmessage = event => {
      if (discardMessages.current) return
      const m = event.data
      if (m.type === 'loading') setDetail(m.detail)
      if (m.type === 'progress') { setProcessedSeconds(m.processedSeconds); if (m.bufferedTruncated) setRecorderNotice('录音超过 20 分钟，重新转写只能覆盖前 20 分钟的内容。') }
      if (m.type === 'ready') { changeStatus('ready'); setDetail('本地语音模型已就绪') }
      if (m.type === 'error') failWorker(m.detail || '语音模型处理失败。')
      if (m.type === 'transcript') { finalRef.current = m.final; interimRef.current = m.interim; segmentsRef.current = m.segments || []; setFinal(m.final); setInterim(m.interim); setSegments(segmentsRef.current) }
      if (m.type === 'finished') {
        finalRef.current = m.text; interimRef.current = ''; segmentsRef.current = m.segments || []
        setFinal(m.text); setInterim(''); setSegments(segmentsRef.current); setProcessedSeconds(m.processedSeconds)
        setFinishedSeq(seq => seq + 1)
        setFinishTimedOut(false)
        if (m.truncated) setRecorderNotice('录音超过 20 分钟，本次重新转写只覆盖前 20 分钟，建议分次练习。')
        const pendingFinish = finishResolve.current
        finishResolve.current = null
        pendingFinish?.(m.text)
        changeStatus('ready')
      }
    }
    // 工作线程崩溃或消息反序列化失败时，不能让状态停留在「准备语音模型」或「正在收尾转写」。
    w.onerror = event => { if (!discardMessages.current) failWorker(event instanceof ErrorEvent && event.message ? event.message : '语音模型工作线程异常退出。') }
    w.onmessageerror = () => { if (!discardMessages.current) failWorker('语音模型返回了无法读取的数据。') }
    w.postMessage({ type: 'init' })
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
      // 卸载或离开练习页时兑现挂起的收尾 Promise，避免调用方永久等待。
      const pendingFinish = finishResolve.current
      finishResolve.current = null
      pendingFinish?.(finalRef.current + interimRef.current)
      if (displayTimer.current !== null) { window.clearTimeout(displayTimer.current); displayTimer.current = null; displayPending.current = null }
      if (worker.current === w) worker.current = null
      w.terminate()
      audio.current?.stream.getTracks().forEach(t => t.stop())
      void audio.current?.context.close().catch(() => {})
      audio.current = null
      changeStatus('loading')
    }
  }, [enabled, workerNonce])

  useEffect(() => {
    const syncPreference = () => {
      if (statusRef.current === 'recording' || statusRef.current === 'paused' || statusRef.current === 'finishing') return
      const id = readMicrophonePreference().id
      deviceIdRef.current = id; setDeviceIdState(id)
    }
    window.addEventListener('echomind-microphone-changed', syncPreference)
    return () => window.removeEventListener('echomind-microphone-changed', syncPreference)
  }, [])

  const start = useCallback(async () => {
    if (statusRef.current !== 'ready' || deviceBusyRef.current) return
    let streamForCleanup: MediaStream | null = null
    let contextForCleanup: AudioContext | null = null
    try {
      setCaptureError(''); setRecorderNotice('')
      let selectedId = deviceIdRef.current
      const preference = readMicrophonePreference()
      if (selectedId && selectedId === preference.id && preference.label) {
        try {
          const available = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
          if (!available.some(device => device.deviceId === selectedId)) selectedId = available.find(device => device.label === preference.label)?.deviceId || selectedId
        } catch { /* Keep the saved device ID when enumeration is unavailable. */ }
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(selectedId ? { deviceId: { exact: selectedId } } : {}) }, video: false })
      } catch (error) {
        if (!selectedId || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        setCaptureError('已保存的麦克风不可用，本次使用系统默认设备。请在设备设置中重新选择。')
      }
      streamForCleanup = stream
      const track = stream.getAudioTracks()[0]
      setMicrophone(track.label || '默认麦克风')
      const actualId = track.getSettings().deviceId || deviceIdRef.current
      deviceIdRef.current = actualId; setDeviceIdState(actualId)
      const available = await navigator.mediaDevices.enumerateDevices()
      setDevices(available.filter(device => device.kind === 'audioinput'))
      const context = new AudioContext()
      contextForCleanup = context
      await context.audioWorklet.addModule('/audio-processor.js')
      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'echomind-audio')
      // Keep the worklet in the graph without playing microphone input.
      const mute = context.createGain(); mute.gain.value = 0
      source.connect(node); node.connect(mute); mute.connect(context.destination)
      activeTime.current = 0; silenceStart.current = null; eventsRef.current = []; setEvents([]); setFinal(''); setInterim(''); setSegments([]); segmentsRef.current = []; setDuration(0); setProcessedSeconds(0); setInputLevel(0); setPeakLevel(0); setSignalWarning(false); setFinishTimedOut(false); peakRef.current = 0; noSignalSeconds.current = 0
      finalRef.current = ''; interimRef.current = ''
      worker.current?.postMessage({ type: 'start' })
      node.port.onmessage = event => {
        // 收尾期间继续接收 80ms 内 flush 出来的尾音，避免丢掉最后一段。
        if (statusRef.current !== 'recording' && statusRef.current !== 'finishing') return
        const samples = event.data as Float32Array
        const startTime = activeTime.current
        activeTime.current += samples.length / context.sampleRate
        let energy = 0
        for (const sample of samples) energy += sample * sample
        const rms = Math.sqrt(energy / samples.length)
        const level = Math.min(100, Math.round(rms * 1200))
        if (level > peakRef.current) peakRef.current = level
        // 时长、电平与峰值合并提交，避免每个音频块都触发整页重渲染。
        queueDisplay({ duration: activeTime.current, level, peak: peakRef.current })
        if (rms < 0.003) noSignalSeconds.current += samples.length / context.sampleRate
        else noSignalSeconds.current = 0
        if (noSignalSeconds.current > 4) setSignalWarning(true)
        else if (rms >= 0.003) setSignalWarning(false)
        if (rms < 0.012) {
          if (silenceStart.current === null) silenceStart.current = startTime
          if (activeTime.current - silenceStart.current > 3) setSilenceHint(true)
        } else closeSilence(activeTime.current)
        worker.current?.postMessage({ type: 'audio', samples, sampleRate: context.sampleRate }, [samples.buffer])
      }
      audio.current = { context, source, node, stream }
      changeStatus('recording')
    } catch (error) { streamForCleanup?.getTracks().forEach(track => track.stop()); if (contextForCleanup) void contextForCleanup.close(); setCaptureError(error instanceof Error ? error.message : String(error)); changeStatus('ready') }
  }, [])

  const pause = useCallback(() => { if (statusRef.current === 'recording') { closeSilence(activeTime.current); changeStatus('paused') } }, [])
  const resume = useCallback(() => { if (statusRef.current === 'paused') changeStatus('recording') }, [])
  const finish = useCallback(async () => {
    if (statusRef.current !== 'recording' && statusRef.current !== 'paused') return { raw: finalRef.current + interimRef.current, segments: segmentsRef.current, duration: activeTime.current, events: eventsRef.current }
    if (!worker.current) {
      // 工作线程已不在：释放麦克风并明确报错，不能停在「正在收尾转写」。
      releaseAudio()
      setDetail('语音模型已停止')
      changeStatus('error')
      return { raw: finalRef.current + interimRef.current, segments: segmentsRef.current, duration: activeTime.current, events: eventsRef.current }
    }
    closeSilence(activeTime.current); changeStatus('finishing')
    if (displayTimer.current !== null) { window.clearTimeout(displayTimer.current); displayTimer.current = null; displayPending.current = null }
    const current = audio.current
    if (current) {
      // flush 与 80ms 等待只负责尾音；任一步失败都不能让收尾停在这里。
      try { current.node.port.postMessage('flush') } catch { /* 端口可能已关闭。 */ }
      await new Promise(resolve => setTimeout(resolve, 80))
      releaseAudio()
    }
    // 80ms 内工作线程可能已经报错；此时不要再等 15 秒，直接返回已识别的文字。
    if (statusIsError()) return { raw: finalRef.current + interimRef.current, segments: segmentsRef.current, duration: activeTime.current, events: eventsRef.current }
    const raw = await awaitTranscript({ type: 'finish' })
    return { raw, segments: segmentsRef.current, duration: activeTime.current, events: eventsRef.current }
  }, [])

  const retryTranscription = useCallback(async () => {
    if (statusRef.current !== 'ready') return { raw: finalRef.current, segments: segmentsRef.current }
    if (!worker.current) return { raw: finalRef.current, segments: segmentsRef.current }
    changeStatus('finishing')
    // 重新转写要重新解码整段音频，不能用收尾的 15 秒兜底。
    const raw = await awaitTranscript({ type: 'replay' }, REPLAY_TIMEOUT_MS)
    return { raw, segments: segmentsRef.current }
  }, [])

  // 回答已确认，通知工作线程释放重转所需的音频缓冲。
  const release = useCallback(() => { worker.current?.postMessage({ type: 'reset' }) }, [])

  /**
   * 切换练习、确认回答或重新开始时清空展示与采集状态。
   * 录音/收尾/重转写/工作线程异常期间会重建 worker，避免旧录音的迟到消息写进新练习。
   */
  const reset = useCallback(() => {
    const pendingFinish = finishResolve.current
    finishResolve.current = null
    const previousStatus = statusRef.current
    const needsRestart = pendingFinish !== null
      || previousStatus === 'recording' || previousStatus === 'paused' || previousStatus === 'finishing' || previousStatus === 'error'
    // 先兑现挂起的收尾/重转写 Promise，避免调用方等满超时。
    pendingFinish?.(finalRef.current + interimRef.current)
    releaseAudio()
    if (displayTimer.current !== null) { window.clearTimeout(displayTimer.current); displayTimer.current = null }
    displayPending.current = null
    activeTime.current = 0
    silenceStart.current = null
    peakRef.current = 0
    noSignalSeconds.current = 0
    finalRef.current = ''
    interimRef.current = ''
    segmentsRef.current = []
    eventsRef.current = []
    setFinal(''); setInterim(''); setSegments([]); setEvents([])
    setDuration(0); setProcessedSeconds(0); setInputLevel(0); setPeakLevel(0)
    setSignalWarning(false); setSilenceHint(false); setFinishTimedOut(false)
    setCaptureError(''); setRecorderNotice('')
    worker.current?.postMessage({ type: 'reset' })
    if (needsRestart) {
      discardMessages.current = true
      changeStatus('loading')
      setWorkerNonce(value => value + 1)
    } else if (previousStatus !== 'loading') {
      changeStatus('ready')
    }
  }, [])

  const refreshDevices = useCallback(async () => {
    if (deviceBusyRef.current) return
    deviceBusyRef.current = true; setDeviceBusy(true); setCaptureError('')
    let probe: MediaStream | null = null
    try {
      // Permission unlocks real device names before the user starts answering.
      if (!audio.current) probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'))
    } catch (error) { setCaptureError(error instanceof Error ? error.message : String(error)) }
    finally { probe?.getTracks().forEach(t => t.stop()); deviceBusyRef.current = false; setDeviceBusy(false) }
  }, [])

  const setDeviceId = useCallback(async (value: string) => {
    if (deviceBusyRef.current) return
    const current = audio.current
    if (!current) { deviceIdRef.current = value; setDeviceIdState(value); return }
    deviceBusyRef.current = true; setDeviceBusy(true); setCaptureError('')
    let replacement: MediaStream | null = null
    try {
      replacement = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: value ? { exact: value } : undefined, echoCancellation: true, noiseSuppression: true } })
      // Recording may have ended while the permission request was pending.
      if (audio.current !== current || !['recording', 'paused'].includes(statusRef.current)) { replacement.getTracks().forEach(t => t.stop()); return }
      const source = current.context.createMediaStreamSource(replacement)
      current.source.disconnect()
      source.connect(current.node)
      current.stream.getTracks().forEach(t => t.stop())
      current.source = source; current.stream = replacement
      const track = replacement.getAudioTracks()[0]
      const actualId = track.getSettings().deviceId || value
      deviceIdRef.current = actualId; setDeviceIdState(actualId); setMicrophone(track.label || '默认麦克风')
      closeSilence(activeTime.current); noSignalSeconds.current = 0; peakRef.current = 0
      setInputLevel(0); setPeakLevel(0); setSignalWarning(false)
    } catch (error) { replacement?.getTracks().forEach(t => t.stop()); setCaptureError(`切换失败，仍使用原设备：${error instanceof Error ? error.message : String(error)}`) }
    finally { deviceBusyRef.current = false; setDeviceBusy(false) }
  }, [])

  return { status, detail, captureError, recorderNotice, final, interim, segments, finishedSeq, finishTimedOut, duration, events, silenceHint, inputLevel, peakLevel, signalWarning, processedSeconds, microphone, devices, deviceId, deviceBusy, refreshDevices, setDeviceId, start, pause, resume, finish, retryTranscription, release, reset }
}
