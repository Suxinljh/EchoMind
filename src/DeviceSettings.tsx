import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { readMicrophonePreference, saveMicrophonePreference } from './microphonePreference'

export default function DeviceSettings() {
  const [preference, setPreference] = useState(readMicrophonePreference)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [peak, setPeak] = useState(0)
  const [activeName, setActiveName] = useState('')
  const [message, setMessage] = useState('')
  const testRef = useRef<{ stream: MediaStream; context: AudioContext; frame: number } | null>(null)
  const versionRef = useRef(0)

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list.filter(device => device.kind === 'audioinput'))
    } catch (error) { setMessage(`无法读取麦克风列表：${error instanceof Error ? error.message : String(error)}`) }
  }, [])

  const stopTest = useCallback(() => {
    versionRef.current++
    const current = testRef.current
    testRef.current = null
    if (current) {
      cancelAnimationFrame(current.frame)
      current.stream.getTracks().forEach(track => track.stop())
      void current.context.close()
    }
    setTesting(false); setLevel(0)
  }, [])

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) { setMessage('当前浏览器无法读取麦克风设备。'); return }
    void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => { navigator.mediaDevices.removeEventListener('devicechange', refreshDevices); stopTest() }
  }, [refreshDevices, stopTest])

  function chooseDevice(id: string) {
    stopTest(); setPeak(0); setActiveName(''); setMessage('')
    const device = devices.find(item => item.deviceId === id)
    const next = { id, label: device?.label || '' }
    setPreference(next)
    try { saveMicrophonePreference(next) } catch { setMessage('浏览器无法保存默认麦克风，请检查本地存储权限。') }
  }

  async function startTest() {
    if (!navigator.mediaDevices?.getUserMedia) { setMessage('当前浏览器无法测试麦克风。'); return }
    stopTest(); setPeak(0); setMessage('正在连接麦克风…')
    const version = versionRef.current
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(preference.id ? { deviceId: { exact: preference.id } } : {}) }, video: false })
      if (version !== versionRef.current) { stream.getTracks().forEach(track => track.stop()); return }
      context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      await context.resume()
      if (version !== versionRef.current) { stream.getTracks().forEach(track => track.stop()); void context.close(); return }
      const samples = new Float32Array(analyser.fftSize)
      const track = stream.getAudioTracks()[0]
      setActiveName(track.label || '默认麦克风')
      setTesting(true)
      setMessage('请对着麦克风说几句话，观察电平和峰值。')
      const current = { stream, context, frame: 0 }
      testRef.current = current
      let lastUpdate = 0
      const measure = (time: number) => {
        if (testRef.current !== current) return
        if (time - lastUpdate >= 80) {
          analyser.getFloatTimeDomainData(samples)
          let energy = 0
          for (const sample of samples) energy += sample * sample
          const next = Math.min(100, Math.round(Math.sqrt(energy / samples.length) * 1200))
          setLevel(next); setPeak(previous => Math.max(previous, next))
          lastUpdate = time
        }
        current.frame = requestAnimationFrame(measure)
      }
      current.frame = requestAnimationFrame(measure)
      await refreshDevices()
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop())
      if (context) void context.close()
      if (version === versionRef.current) setMessage(`麦克风测试失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const selectedMissing = !!preference.id && devices.length > 0 && !devices.some(device => device.deviceId === preference.id)
  return <div className="device-settings" role="tabpanel" id="device-settings-panel" aria-labelledby="device-settings-tab">
    <p className="settings-intro">选择常用麦克风后，练习录音会优先使用它。设备选择只保存在此浏览器中。</p>
    <label className="field">默认麦克风
      <select value={preference.id} onChange={event => chooseDevice(event.target.value)}>
        <option value="">跟随系统默认设备</option>
        {selectedMissing && <option value={preference.id}>{preference.label || '已保存的麦克风'}（当前未找到）</option>}
        {devices.filter(device => device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}
      </select>
    </label>
    {selectedMissing && <p className="device-alert">已保存的麦克风当前不可用。可重新选择；开始录音时会尝试使用系统默认设备。</p>}
    <div className="device-test-card">
      <div className="device-test-head"><div><strong>输入电平测试</strong><span>{testing ? `正在使用：${activeName}` : '点击测试后允许浏览器使用麦克风'}</span></div>{testing ? <button className="secondary-button" onClick={stopTest}><Square size={14}/> 停止测试</button> : <button className="primary-button" onClick={() => void startTest()}><Mic size={16}/> 测试麦克风</button>}</div>
      <div className="device-meter" role="meter" aria-label="麦克风输入电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}><span style={{ width: `${level}%` }}/></div>
      <div className="device-level-label"><span>当前电平 {level}%</span><span>峰值 {peak}%</span></div>
      <p className={peak >= 4 ? 'device-success' : 'device-hint'}>{testing && peak >= 4 ? '已检测到麦克风输入，这个设备可以直接用于练习。' : message || '测试时说话，确认电平随声音变化。'}</p>
    </div>
  </div>
}
