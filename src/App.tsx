import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Download, ExternalLink, FileText, GitBranch, LockKeyhole, Mic, Pause, Play, Plus, RotateCcw, Settings2, ShieldCheck, SkipForward, Sparkles, Square, Target, X } from 'lucide-react'
import { localEvaluation, offlineTasks, overallScore, questionScore, reportStats, speechStats, tentativeFillers, transcriptParagraphs } from './logic'
import { captureReportAppearance, createReportHtml } from './reportExport'
import DeviceSettings from './DeviceSettings'
import Logo from './Logo'
import packageJson from '../package.json'
import ThemeSettings from './ThemeSettings'
import { readTheme, saveTheme, type ThemeId } from './themes'
import type { Answer, InterviewSettings, Mode, Provider, ReportSettings, Session, Stage, Task } from './types'
import { useRecorder } from './useRecorder'
import './styles.css'
import './theme.css'
import './report.css'

const initialInterview: InterviewSettings = { position: '', jd: '', questionCount: 5, includeIntro: true, includeCandidate: true }
const initialReport: ReportSettings = { topic: '', audience: '', purpose: '同步进展', secondaryPurpose: '', outline: '' }
const initialProvider: Provider = { baseUrl: '', apiKey: '', model: '' }
const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const historyKey = 'echomind-practice-history-v1'
const providerKey = 'echomind-model-config-v1'
function newestFirst(items: Session[]): Session[] { return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) }
function readHistory(): Session[] { try { const value = JSON.parse(localStorage.getItem(historyKey) || '[]'); return Array.isArray(value) ? newestFirst(value) : [] } catch { return [] } }
function readProvider(): Provider { try { return { ...initialProvider, ...JSON.parse(localStorage.getItem(providerKey) || '{}'), apiKey: sessionStorage.getItem('echomind-api-key') || '' } } catch { return initialProvider } }

export default function App() {
  const [mode, setMode] = useState<Mode>('interview')
  const [stage, setStage] = useState<Stage>('home')
  const [interview, setInterview] = useState(initialInterview)
  const [report, setReport] = useState(initialReport)
  const [provider, setProvider] = useState(readProvider)
  const [history, setHistory] = useState<Session[]>(readHistory)
  const [modePickerOpen, setModePickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'model' | 'device' | 'theme'>('model')
  const [theme, setTheme] = useState<ThemeId>(readTheme)
  const [providerState, setProviderState] = useState('')
  const [privacyConsent, setPrivacyConsent] = useState(() => sessionStorage.getItem('echomind-model-consent') === 'yes')
  const [session, setSession] = useState<Session | null>(null)
  const [pending, setPending] = useState<{ raw: string; segments: string[]; semantic: string; duration: number; events: Answer['events'] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [selectedResult, setSelectedResult] = useState(0)
  const recorder = useRecorder(stage === 'practice')
  const task = session?.tasks[session.current]
  const readyForAI = !!provider.baseUrl && !!provider.model && privacyConsent
  const results = useMemo(() => session?.tasks.map(t => ({ task: t, answer: session.answers.find(a => a.taskId === t.id) })) || [], [session])
  const summaryStats = useMemo(() => session ? reportStats(session) : null, [session])
  const totalScore = session ? overallScore(session) : null
  const needsAnalysis = !!session && session.answers.some(a => a.status === 'answered') && (session.answers.some(a => a.status === 'answered' && a.evaluation?.source !== 'ai') || !session.overallAnalysis)
  const liveText = recorder.final + recorder.interim
  const liveStats = speechStats(pending?.raw || liveText)
  const liveParagraphs = transcriptParagraphs(pending?.segments || [...recorder.segments, recorder.interim])

  useEffect(() => { localStorage.setItem(providerKey, JSON.stringify({ baseUrl: provider.baseUrl, model: provider.model })); sessionStorage.setItem('echomind-api-key', provider.apiKey) }, [provider])
  useEffect(() => { sessionStorage.setItem('echomind-model-consent', privacyConsent ? 'yes' : 'no') }, [privacyConsent])
  useEffect(() => { document.documentElement.dataset.theme = theme; saveTheme(theme) }, [theme])
  useEffect(() => { if (!session) return; setHistory(current => { const next = newestFirst([session, ...current.filter(item => item.createdAt !== session.createdAt)]); try { localStorage.setItem(historyKey, JSON.stringify(next)) } catch { setNotice('浏览器存储空间不足，练习历史未保存。') } return next }) }, [session])

  async function createSession() {
    setNotice('')
    if (mode === 'interview' && (!interview.position.trim() || !interview.jd.trim())) { setNotice('请填写岗位和 JD。'); return }
    if (mode === 'report' && (!report.topic.trim() || !report.audience.trim() || !report.purpose.trim())) { setNotice('请填写汇报主题、听众和主要目的。'); return }
    setBusy(true)
    let tasks: Task[]
    if (mode === 'interview' && readyForAI) {
      try { tasks = await (await import('./ai')).planInterview(provider, interview) }
      catch (error) { tasks = offlineTasks(mode, interview); setNotice(`AI 出题失败，已使用基础问题：${error instanceof Error ? error.message : String(error)}`) }
    } else tasks = offlineTasks(mode, mode === 'interview' ? interview : report)
    setSession({ mode, tasks, answers: [], current: 0, settings: mode === 'interview' ? { ...interview } : { ...report }, createdAt: new Date().toISOString() })
    setStage('practice'); setPending(null); setBusy(false)
  }

  async function stopRecording() {
    const result = await recorder.finish()
    setPending({ ...result, semantic: transcriptParagraphs(result.segments.length ? result.segments : [result.raw]).join('\n\n') })
    if (!result.raw.trim()) setNotice(recorder.peakLevel < 4 ? '未识别到文字，且麦克风输入电平很低。请检查下方麦克风设备，换一个设备后重录。' : '录到了麦克风信号，但模型没有输出文字。请先点“重新转写”；仍为空可换麦克风重录。')
  }

  async function retryPendingTranscription() {
    if (!pending) return
    setBusy(true)
    const result = await recorder.retryTranscription()
    setPending(current => current ? { ...current, raw: result.raw, segments: result.segments, semantic: current.semantic || transcriptParagraphs(result.segments.length ? result.segments : [result.raw]).join('\n\n') } : current)
    setNotice(result.raw.trim() ? '重新转写完成。请核对语义稿。' : '重新转写仍为空。请切换麦克风设备并重录；当前回答不会被确认。')
    setBusy(false)
  }

  function commitAnswer(status: Answer['status']) {
    if (!session || !task) return
    if (status === 'answered' && !pending?.semantic.trim()) { setNotice('语义稿为空。请确认转写，或在语义稿中补录文字。'); return }
    const answer: Answer = {
      taskId: task.id, raw: status === 'skipped' ? '' : pending?.raw || '', rawSegments: status === 'skipped' ? [] : pending?.segments || [], semantic: status === 'skipped' ? '' : pending?.semantic || '',
      duration: status === 'skipped' ? 0 : pending?.duration || 0, events: status === 'skipped' ? [] : pending?.events || [], status,
      confirmedAt: new Date().toISOString(),
    }
    if (status === 'answered') answer.evaluation = localEvaluation(task, answer)
    const next = { ...session, answers: [...session.answers, answer], current: session.current + 1 }
    setSession(next); setPending(null); setNotice('')
    if (next.current >= next.tasks.length) { setStage('results'); setSelectedResult(0) }
    if (status === 'answered' && readyForAI) void runEvaluation(next, answer)
  }

  async function runEvaluation(target: Session, answer: Answer) {
    const item = target.tasks.find(t => t.id === answer.taskId)
    if (!item || !readyForAI) return
    try {
      const evaluation = await (await import('./ai')).evaluate(provider, item, answer, target.settings)
      setSession(current => current?.createdAt === target.createdAt ? { ...current, overallAnalysis: undefined, answers: current.answers.map(a => a.taskId === answer.taskId && a.semantic === answer.semantic ? { ...a, evaluation } : a) } : current)
    } catch (error) { setNotice(`评估失败：${error instanceof Error ? error.message : String(error)}。回答已保存，可在报告中重试。`) }
  }

  function editSemantic(taskId: string, value: string) {
    setSession(current => current ? { ...current, overallAnalysis: undefined, answers: current.answers.map(a => a.taskId === taskId ? { ...a, semantic: value, evaluation: localEvaluation(current.tasks.find(t => t.id === taskId)!, { ...a, semantic: value }) } : a) } : current)
  }

  function startNew(mode: Mode) { setMode(mode); setSession(null); setPending(null); setStage('setup'); setNotice(''); setModePickerOpen(false) }
  function openHistory(item: Session) { setSession(item); setMode(item.mode); setPending(null); setSelectedResult(0); setStage(item.current >= item.tasks.length ? 'results' : 'practice'); setNotice('') }

  async function evaluateReport() {
    if (!session) return
    if (!readyForAI) { setSettingsOpen(true); return }
    setBusy(true); setNotice('正在生成分析报告…')
    let failures = 0
    let firstError = ''
    const updatedAnswers = [...session.answers]
    for (const answer of session.answers.filter(item => item.status === 'answered' && item.semantic.trim() && item.evaluation?.source !== 'ai')) {
      const item = session.tasks.find(task => task.id === answer.taskId)
      if (!item) continue
      try {
        const evaluation = await (await import('./ai')).evaluate(provider, item, answer, session.settings)
        const index = updatedAnswers.findIndex(saved => saved.taskId === answer.taskId)
        if (index >= 0) updatedAnswers[index] = { ...answer, evaluation }
        setSession(current => current?.createdAt === session.createdAt ? { ...current, answers: current.answers.map(saved => saved.taskId === answer.taskId && saved.semantic === answer.semantic ? { ...saved, evaluation } : saved) } : current)
      } catch (error) { failures++; if (!firstError) firstError = error instanceof Error ? error.message : String(error) }
    }
    if (!failures && updatedAnswers.some(answer => answer.status === 'answered')) {
      try {
        const overallAnalysis = await (await import('./ai')).analyzeSession(provider, { ...session, answers: updatedAnswers })
        setSession(current => current?.createdAt === session.createdAt ? { ...current, overallAnalysis } : current)
      } catch (error) { failures++; firstError = error instanceof Error ? error.message : String(error) }
    }
    setBusy(false); setNotice(failures ? `报告有 ${failures} 处未完成：${firstError}` : '分析报告已更新。')
  }

  function exportReport(open: boolean) {
    if (!session) return
    const url = URL.createObjectURL(new Blob([createReportHtml(session, captureReportAppearance(theme))], { type: 'text/html;charset=utf-8' }))
    if (open) {
      const tab = window.open(url, '_blank', 'noopener,noreferrer')
      if (!tab) setNotice('浏览器拦截了新标签页，请使用下载。')
    } else {
      const link = document.createElement('a')
      link.href = url; link.download = `EchoMind-练习报告-${session.createdAt.slice(0, 10)}.html`; link.click()
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  const selected = results[selectedResult]
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-group"><button className="brand" onClick={() => { if (stage === 'setup') setMode('interview') }} aria-label="EchoMind 首页"><Logo/></button><a className="beta-badge" href="/changelog" aria-label="查看更新日志">v{packageJson.version} Beta</a></div>
      <div className="top-right"><span className="privacy-chip"><ShieldCheck size={15}/> 仅本地录音</span><button className="icon-button" aria-label="模型设置" onClick={() => setSettingsOpen(true)}><Settings2 size={19}/></button></div>
    </header>
    <div className="layout">
      <aside className="sidebar">
        <button className="new-practice-button" onClick={() => setModePickerOpen(true)}><Plus size={18}/> 新建练习</button>
        <div className="sidebar-divider"/>
        <div className="sidebar-label">练习历史</div>
        {history.length === 0 ? <div className="empty-history">没有历史，快速开始</div> : <div className="history-list">{history.map(item => <button key={item.createdAt} className={`history-item ${session?.createdAt === item.createdAt ? 'active' : ''}`} onClick={() => openHistory(item)}><span className="history-icon">{item.mode === 'interview' ? <Target size={16}/> : <FileText size={16}/>}</span><span><strong>{item.mode === 'interview' ? (item.settings as InterviewSettings).position || '模拟面试' : (item.settings as ReportSettings).topic || '工作汇报'}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {item.current >= item.tasks.length ? '已完成' : `${item.current}/${item.tasks.length} 环节`}</small></span></button>)}</div>}
        <div className="sidebar-meta"><a className="sidebar-link" href="/changelog"><BookOpen size={17}/> 更新日志 <ChevronRight size={14}/></a><a className="sidebar-link" href="https://github.com/Suxinljh/EchoMind" target="_blank" rel="noopener noreferrer"><GitBranch size={17}/> GitHub <ExternalLink size={14}/></a><div className="sidebar-bottom"><ShieldCheck size={18}/><div><strong>隐私优先</strong><p>音频在浏览器内处理。练习文字保存在本机浏览器；启用模型后才会发送指定文字。</p></div></div></div>
      </aside>
      <main className="main-area">
        {stage === 'home' && <div className="home-page"><h1>把想法，说得更清楚。</h1><p className="hero-copy">选择一个真实场景，开始练习表达。录音会在本机转录，完成后可回看报告。</p><button className="primary-button" onClick={() => setModePickerOpen(true)}><Plus size={17}/> 新建练习</button></div>}
        {stage === 'setup' && <div className="setup-page">

          <h1>把想法，说得更清楚。</h1><p className="hero-copy">为真实场景练习表达。录下回答，保留原始转写，再用证据回看自己说了什么。</p>
          <div className="setup-toolbar"><div className="setup-mode-label">{mode === 'interview' ? <Target size={17}/> : <FileText size={17}/>} {mode === 'interview' ? '模拟面试' : '工作汇报'} <button onClick={() => setModePickerOpen(true)}>切换类型</button></div><button className="primary-button" disabled={busy} onClick={createSession}>{busy ? '正在准备…' : '开始练习'} <ArrowRight size={18}/></button></div>
          <section className="card setup-card"><div className="section-heading"><div><span className="step-label">01 / 场景设定</span><h2>{mode === 'interview' ? '设定面试场景' : '设定汇报场景'}</h2></div></div>
            {mode === 'interview' ? <div className="form-grid">
              <label className="field full">目标岗位 <span>*</span><input value={interview.position} onChange={e => setInterview({ ...interview, position: e.target.value })} placeholder="例如：产品经理"/></label>
              <label className="field full">岗位描述 JD <span>*</span><textarea rows={5} value={interview.jd} onChange={e => setInterview({ ...interview, jd: e.target.value })} placeholder="粘贴岗位职责与任职要求，AI 将据此生成针对性问题"/></label>
              <label className="field">专业问题数量 <span className="hint">1–15</span><input type="number" min={1} max={15} value={interview.questionCount} onChange={e => setInterview({ ...interview, questionCount: Math.min(15, Math.max(1, Number(e.target.value) || 1)) })}/></label>
              <div className="checkbox-group"><label><input type="checkbox" checked={interview.includeIntro} onChange={e => setInterview({ ...interview, includeIntro: e.target.checked })}/> 包含自我介绍</label><label><input type="checkbox" checked={interview.includeCandidate} onChange={e => setInterview({ ...interview, includeCandidate: e.target.checked })}/> 包含向面试官提问</label></div>
            </div> : <div className="form-grid">
              <label className="field">汇报主题 <span>*</span><input value={report.topic} onChange={e => setReport({ ...report, topic: e.target.value })} placeholder="例如：本周项目进展"/></label>
              <label className="field">听众 <span>*</span><input value={report.audience} onChange={e => setReport({ ...report, audience: e.target.value })} placeholder="例如：直属主管"/></label>
              <label className="field">主要目的 <span>*</span><select value={report.purpose} onChange={e => setReport({ ...report, purpose: e.target.value })}><option>同步进展</option><option>争取资源</option><option>推动决策</option><option>复盘总结</option></select></label>
              <label className="field">次要目的 <span className="hint">可选</span><input value={report.secondaryPurpose} onChange={e => setReport({ ...report, secondaryPurpose: e.target.value })} placeholder="例如：澄清下一步"/></label>
              <label className="field full">计划要点 <span className="hint">可选</span><textarea rows={4} value={report.outline} onChange={e => setReport({ ...report, outline: e.target.value })} placeholder="写下你准备覆盖的关键点；报告会据此检查覆盖情况"/></label>
            </div>}
          </section>
          <section className="setup-model-row"><div className="model-notice"><Sparkles size={17}/><div><strong>{readyForAI ? '已填写模型配置' : '可先用基础问题练习'}</strong><span>{readyForAI ? '开始后会调用你设置的模型生成问题并评估文字。' : '连接自备模型后，可获得针对 JD 的问题和证据化反馈。'}</span></div></div><button className="secondary-button" onClick={() => setSettingsOpen(true)}>模型设置 <ArrowRight size={14}/></button></section>
        </div>}
        {stage === 'practice' && session && task && <div className="practice-page">
          <div className="page-topline"><button className="text-button" onClick={() => setModePickerOpen(true)}><ArrowLeft size={16}/> 新练习</button><span>环节 {session.current + 1} / {session.tasks.length}</span></div>
          <div className="practice-heading"><div><h1>{task.title}</h1></div></div>
          <div className="practice-grid"><div className="practice-primary">
            <section className="card question-card"><div className="question-label"><span className="question-number">{String(session.current + 1).padStart(2, '0')}</span> 当前任务</div><h2>{task.prompt}</h2>{task.jdEvidence && <div className="jd-evidence">JD 依据：{task.jdEvidence}</div>}</section>
            <section className="card recording-card"><div className="record-top"><div><h3>你的回答</h3></div><span className={`record-indicator ${recorder.status === 'recording' ? 'live' : ''}`}><span/> {recorder.status === 'recording' ? '录音中' : recorder.status === 'paused' ? '已暂停' : pending ? '待确认' : '待录音'}</span></div>
              <div className="transcript-area">{pending ? <><div className="transcript-label">原始转写 · 自动分段 · 确认后锁定</div><div className="transcript-paragraphs">{liveParagraphs.length ? liveParagraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>) : <p className="empty-transcript">未识别到文字</p>}</div><label className="field semantic-field">语义稿 · 可修正识别错误<textarea rows={6} value={pending.semantic} onChange={e => setPending({ ...pending, semantic: e.target.value })} placeholder="修正 ASR 错字，保留真实语义"/></label></> : <><div className="transcript-label">实时转录 · 自动分段</div><div className="transcript-paragraphs">{liveParagraphs.length ? liveParagraphs.map((paragraph, i) => <p key={i} className={i === liveParagraphs.length - 1 && recorder.interim ? 'interim' : ''}>{paragraph}</p>) : <p className="empty-transcript">开始录音后，文字会出现在这里…</p>}</div></>}</div>
              <div className="audio-diagnostics">
                <label className="device-picker">麦克风设备
                  <select aria-label="麦克风设备" disabled={recorder.deviceBusy || recorder.status === 'finishing'} value={recorder.deviceId} onChange={e => { void recorder.setDeviceId(e.target.value) }}>
                    <option value="">浏览器默认设备</option>
                    {recorder.devices.filter(device => device.deviceId).map((device, i) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${i + 1}`}</option>)}
                  </select>
                  <button className="text-button" disabled={recorder.deviceBusy || recorder.status === 'finishing'} onClick={recorder.refreshDevices}>{recorder.deviceBusy ? '连接中…' : '授权并刷新设备'}</button>
                </label>
                <div className="mic-line"><span>{recorder.status === 'recording' || recorder.status === 'paused' ? `正在使用：${recorder.microphone}` : '录音前可选择设备；录音中切换会立即生效。'}</span><span>输入峰值 {recorder.peakLevel}%</span></div>
                <div className="mic-meter"><span style={{ width: `${recorder.inputLevel}%` }}/></div>
                {(recorder.status === 'recording' || recorder.status === 'paused' || pending) && <div className="mic-line"><span>模型已处理 {formatTime(recorder.processedSeconds)} / 已录制 {formatTime(pending?.duration ?? recorder.duration)}</span><span>{recorder.inputLevel > 3 ? '检测到输入' : '输入很弱'}</span></div>}
              </div>
              {recorder.captureError && <div className="audio-warning"><CircleHelp size={15}/> 麦克风无法打开：{recorder.captureError}。检查浏览器权限后可重试。</div>}
              {recorder.signalWarning && recorder.status === 'recording' && <div className="audio-warning"><CircleHelp size={15}/> 连续 4 秒没有检测到明显的麦克风输入。请检查 Chrome 的麦克风权限和当前输入设备。</div>}
              {recorder.status === 'recording' && recorder.duration - recorder.processedSeconds > 8 && <div className="audio-warning"><CircleHelp size={15}/> 语音模型处理落后录音超过 8 秒。可以先结束回答，等待剩余音频处理完成。</div>}
              {pending && !pending.raw.trim() && <div className="audio-warning"><CircleHelp size={15}/> 本次原始转写为空。可重新处理已录制音频，或选择麦克风后重录。请不要直接确认空白回答。</div>}
              {recorder.silenceHint && <div className="silence-hint"><CircleHelp size={15}/> 已持续停顿超过 3 秒。可以先说结论或下一步。</div>}
              <div className="record-controls"><div className="timer"><span className={recorder.status === 'recording' ? 'pulse-dot' : ''}/>{formatTime(pending?.duration ?? recorder.duration)} <small>有效时长</small></div><div className="control-actions">{!pending && recorder.status === 'ready' && <button className="primary-button" disabled={recorder.deviceBusy} onClick={recorder.start}><Mic size={17}/> 开始录音</button>}{!pending && recorder.status === 'recording' && <><button className="secondary-button" onClick={recorder.pause}><Pause size={17}/> 暂停</button><button className="primary-button" onClick={stopRecording}><Square size={15}/> 结束回答</button></>}{!pending && recorder.status === 'paused' && <><button className="secondary-button" onClick={recorder.resume}><Play size={17}/> 继续</button><button className="primary-button" onClick={stopRecording}><Square size={15}/> 结束回答</button></>}{recorder.status === 'loading' && <span className="muted">{recorder.detail}…</span>}{recorder.status === 'finishing' && <span className="muted">正在收尾转写…</span>}{recorder.status === 'error' && <span className="error-text">语音模型错误：{recorder.detail}</span>}</div></div>
            </section>
            {pending && !pending.raw.trim() && <div className="recovery-actions"><button className="secondary-button" disabled={busy || recorder.status === 'finishing'} onClick={retryPendingTranscription}><RotateCcw size={16}/> 重新转写已录音频</button><button className="secondary-button" disabled={busy || recorder.status === 'finishing'} onClick={() => { setPending(null); setNotice('已清除失败的录音。切换麦克风后请重新录制。') }}><Mic size={16}/> 重录这一题</button></div>}
            {pending && pending.raw.trim() && <div className="confirm-panel"><LockKeyhole size={18}/><p>确认后此回答不可重录，原始转写也不能修改。语义稿可在报告中继续修订。</p><button className="primary-button" onClick={() => commitAnswer('answered')}><Check size={17}/> 确认回答 <ArrowRight size={17}/></button></div>}
            {!pending && recorder.status !== 'recording' && recorder.status !== 'paused' && recorder.status !== 'finishing' && <button className="skip-button" onClick={() => commitAnswer('skipped')}><SkipForward size={16}/> 跳过本题</button>}
          </div><aside className="practice-aside"><div className="tip-card"><div className="tip-icon"><Sparkles size={18}/></div><h3>实时提示</h3><p>{recorder.silenceHint ? '停顿有些长，试着先说结论或下一步。' : '先讲核心结论，再用事实和行动支撑。'}</p></div><div className="analysis-card"><h3>需要留意的表达</h3><div className="stat-group-title">语气词</div>{Object.entries(liveStats.fillers).map(([word, count]) => <div key={word}><span>“{word}”</span><strong>{count} 次</strong></div>)}<div className="stat-group-title">重复连接词</div>{Object.entries(liveStats.transitions).map(([word, count]) => <div key={word}><span>“{word}”</span><strong>{count} 次</strong></div>)}<div className="stat-group-title">节奏</div><div><span>长停顿</span><strong>{recorder.events.filter(e => e.kind === 'silence').length} 次</strong></div><small>根据实时转录与音量估算，仅供练习参考。</small></div></aside></div>
        </div>}
        {stage === 'results' && session && <div className="results-page"><h1>练习报告</h1><p className="hero-copy">{session.mode === 'interview' ? '逐题查看回答、证据与下次练习建议。' : '回看完整汇报，检查目标、听众适配和内容覆盖。'}</p>{needsAnalysis && <div className="report-notice">{readyForAI ? '报告分析尚未完成。可根据已保存的语义稿补全。' : '配置大模型后，可生成逐题与整场分析。'}</div>}
          <div className="result-summary"><div><strong>{session.answers.filter(a => a.status === 'answered').length}</strong><span>已回答</span></div><div><strong>{session.answers.filter(a => a.status === 'skipped').length}</strong><span>已跳过</span></div><div><strong>{formatTime(session.answers.reduce((sum, a) => sum + a.duration, 0))}</strong><span>有效表达</span></div><div className="summary-actions">{needsAnalysis ? <button className="primary-button" disabled={busy} onClick={evaluateReport}><Sparkles size={16}/> {busy ? '正在分析…' : readyForAI ? '生成 / 补全分析报告' : '配置大模型'}</button> : <><button className="secondary-button" onClick={() => exportReport(true)}><ExternalLink size={16}/> 新标签页打开</button><button className="secondary-button" onClick={() => exportReport(false)}><Download size={16}/> 下载报告</button></>}</div></div>
          <section className="card overall-card"><div className="overall-head"><div><h2>整场分析</h2></div><div className="overall-score"><strong>{totalScore?.complete ? `${((totalScore.earned / totalScore.maximum) * 100).toFixed(1)}` : '待评估'}</strong><span>/ 100 分</span></div></div><p className="score-method">{totalScore?.complete ? `加权原始分 ${totalScore.earned.toFixed(1)} / ${totalScore.maximum}；按 100 分换算，跳过题计 0 分。` : '题目按各维度权重计算；证据不足或尚未完成评估时，暂不显示总分。跳过题计 0 分。'}</p><p className="overall-copy">{session.overallAnalysis?.summary || (readyForAI ? '点击“生成 / 补全分析报告”后，这里会显示整场练习的综合评价。' : '完成模型配置后可生成整场综合评价。')}</p>{session.overallAnalysis && <div className="overall-columns"><div><h3>做得较好</h3><ul>{session.overallAnalysis.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul></div><div><h3>优先改进</h3><ul>{session.overallAnalysis.priorities.map((item, i) => <li key={i}>{item}</li>)}</ul></div></div>}</section>
          {summaryStats && <section className="card overall-card"><div className="section-heading"><h2>表达习惯</h2><span className="muted">基于原始转写与音量事件估算</span></div><div className="speech-overview"><div><h3>语气词</h3>{Object.entries(summaryStats.fillers).map(([word, count]) => <p key={word}>“{word}” <strong>{count} 次</strong></p>)}</div><div><h3>重复连接词</h3>{Object.entries(summaryStats.transitions).map(([word, count]) => <p key={word}>“{word}” <strong>{count} 次</strong></p>)}</div><div><h3>相邻重复表达</h3>{summaryStats.repeatedPhrases.length ? summaryStats.repeatedPhrases.map(([phrase, count]) => <p key={phrase}>“{phrase}” <strong>{count} 次</strong></p>) : <p>未检出</p>}</div><div><h3>长停顿</h3><p><strong>{summaryStats.pauses} 次</strong></p></div></div><p className="metrics-note">以上统计仅供练习参考，不参与内容评分。</p></section>}
          <div className="results-grid"><nav className="result-nav">{results.map((r, i) => <button key={r.task.id} className={selectedResult === i ? 'selected' : ''} onClick={() => setSelectedResult(i)}><span>{String(i + 1).padStart(2, '0')}</span><div>{r.task.title}<small>{r.answer?.status === 'skipped' ? '已跳过' : r.answer?.evaluation?.source === 'ai' ? '已评估' : '待 AI 评估'}</small></div><ChevronRight size={15}/></button>)}</nav><div className="result-detail">{selected?.answer && selected.answer.status === 'skipped' ? <div className="card result-card"><h2>{selected.task.title}</h2><p className="muted">本题已跳过，未生成评价。</p></div> : selected?.answer && <><section className="card result-card"><div className="result-card-head"><div><span className="step-label">回答 {selectedResult + 1}</span><h2>{selected.task.title}</h2></div><span className="score-pill">{questionScore(selected.answer) === null ? '证据不足 / 待评估' : `${questionScore(selected.answer)!.toFixed(1)} / 5`}</span></div><p className="question-recap">{selected.task.prompt}</p><div className="question-review"><h3>本题总体评价</h3><p className="eval-summary">{selected.answer.evaluation?.summary}</p><h3>建议回答方式</h3><p>{selected.answer.evaluation?.suggestedAnswer || selected.answer.evaluation?.nextStep || '评估后显示'}</p></div><div className="rubric-list">{selected.answer.evaluation?.dimensions.map(d => <div key={d.name} className="rubric-row"><div className="rubric-title"><strong>{d.name}</strong><span>{d.score === null ? '无法评价' : `${d.score} / 5`} · 权重 {Math.round(d.weight * 100)}%</span></div><p>证据：{d.evidence}</p>{d.advice && <p>建议：{d.advice}</p>}</div>)}</div>{selected.answer.evaluation?.nextStep && <div className="next-step"><Sparkles size={17}/><span>下次练习：{selected.answer.evaluation.nextStep}</span></div>}{selected.answer.evaluation?.source === 'local' && <button className="secondary-button" disabled={!readyForAI} onClick={() => runEvaluation(session, selected.answer!)}><Sparkles size={16}/> 重新评估</button>}</section>
              {selected.answer.evaluation?.usage && <div className="metrics-note">本次评估用量：输入 {selected.answer.evaluation.usage.input ?? '未知'} token，输出 {selected.answer.evaluation.usage.output ?? '未知'} token。费用取决于服务商定价。</div>}
              {selected.answer.evaluation?.audienceChecks && <section className="card result-card"><h3>听众适配检查</h3><div className="checks-grid">{selected.answer.evaluation.audienceChecks.map(c => <div key={c.criterion}><strong>{c.criterion}</strong><span>{c.level === null ? '无法评价' : `${c.level} / 4`}</span><small>{c.evidence}</small></div>)}</div></section>}
              {selected.answer.evaluation?.coverage && selected.answer.evaluation.coverage.length > 0 && <section className="card result-card"><h3>内容覆盖</h3>{selected.answer.evaluation.coverage.map((c, i) => <div className="coverage-row" key={i}><span>{c.item}</span><strong>{c.status === 'covered' ? '已覆盖' : c.status === 'partial' ? '部分覆盖' : '未覆盖'}</strong><small>{c.evidence}</small></div>)}</section>}
              <section className="card result-card">
                <div className="section-heading"><h3>逐字稿</h3><span className="transcript-tag"><LockKeyhole size={13}/> 原始稿已锁定</span></div>
                <p className="transcript-help">修订后仅更新内容评估。原始录音事件与时长保持不变。</p>
                <div className="transcript-pair">
                  <div><strong>原始转写</strong><div className="transcript-paragraphs">{transcriptParagraphs(selected.answer.rawSegments?.length ? selected.answer.rawSegments : [selected.answer.raw]).map((paragraph, i) => <p key={i}>{paragraph}</p>)}{!selected.answer.raw && <p>无原始转写</p>}</div></div>
                  <label className="semantic-editor"><strong>语义稿 · 可修订</strong><textarea rows={8} value={selected.answer.semantic} onChange={e => editSemantic(selected.answer!.taskId, e.target.value)}/></label>
                </div>
                {readyForAI && <div className="transcript-actions"><button className="secondary-button" onClick={() => runEvaluation(session, selected.answer!)}><RotateCcw size={15}/> 评估此版本</button></div>}
              </section><section className="metrics-note">语气词识别 {tentativeFillers(selected.answer.raw)} 次 · 长停顿 {selected.answer.events.filter(e => e.kind === 'silence').length} 次 · 有效时长 {formatTime(selected.answer.duration)}。这些指标仅供参考，不参与评分。</section></>}</div></div></div>}
        {notice && <div className="toast" role="alert"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
      </main>
    </div>
    {modePickerOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModePickerOpen(false) }}><div className="mode-modal" role="dialog" aria-modal="true" aria-label="选择练习类型"><div className="modal-head"><div><h2>选择练习类型</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setModePickerOpen(false)}><X size={20}/></button></div><p>选择场景后进入配置页面。</p><div className="mode-options"><button onClick={() => startNew('interview')}><Target size={22}/><span><strong>模拟面试</strong><small>根据岗位和 JD 练习逐题回答</small></span><ArrowRight size={17}/></button><button onClick={() => startNew('report')}><FileText size={22}/><span><strong>工作汇报</strong><small>围绕主题和听众练习连续表达</small></span><ArrowRight size={17}/></button></div></div></div>}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}><div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置"><div className="modal-head"><div><h2>设置</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setSettingsOpen(false)}><X size={20}/></button></div>
      <div className="settings-tabs" role="tablist" aria-label="设置类型"><button id="model-settings-tab" type="button" role="tab" aria-selected={settingsTab === 'model'} aria-controls="model-settings-panel" className={settingsTab === 'model' ? 'active' : ''} onClick={() => setSettingsTab('model')}>模型设置</button><button id="device-settings-tab" type="button" role="tab" aria-selected={settingsTab === 'device'} aria-controls="device-settings-panel" className={settingsTab === 'device' ? 'active' : ''} onClick={() => setSettingsTab('device')}>设备设置</button><button id="theme-settings-tab" type="button" role="tab" aria-selected={settingsTab === 'theme'} aria-controls="theme-settings-panel" className={settingsTab === 'theme' ? 'active' : ''} onClick={() => setSettingsTab('theme')}>主题风格</button></div>
      {settingsTab === 'model' ? <div role="tabpanel" id="model-settings-panel" aria-labelledby="model-settings-tab"><p className="settings-intro">填写兼容 OpenAI Chat Completions 的服务。接口地址和模型 ID 保存在本机浏览器；API Key 保存在当前标签页会话中，调用时经本机服务转发给提供商。</p><label className="field">接口根地址<input value={provider.baseUrl} onChange={e => setProvider({ ...provider, baseUrl: e.target.value })} placeholder="https://example.com/v1"/></label><label className="field">模型 ID<input value={provider.model} onChange={e => setProvider({ ...provider, model: e.target.value })} placeholder="你的模型名称"/></label><label className="field">API Key<input type="password" autoComplete="off" value={provider.apiKey} onChange={e => setProvider({ ...provider, apiKey: e.target.value })} placeholder="仅保存在当前标签页会话"/></label><div className="privacy-box"><ShieldCheck size={20}/><div><strong>发送范围</strong><p>出题时发送岗位和 JD；评估时发送题目、场景设置和可编辑的语义稿。音频与原始转写不会发送。服务商可能保存或计费，请查看其条款。</p></div></div><label className="consent-row"><input type="checkbox" checked={privacyConsent} onChange={e => setPrivacyConsent(e.target.checked)}/> 我同意将上述文字发送给我配置的服务商</label><div className="modal-actions"><span>{providerState}</span><button className="secondary-button" disabled={!privacyConsent || !provider.baseUrl || !provider.model || busy} onClick={async () => { setBusy(true); setProviderState('正在测试，最多等待 20 秒…'); try { await (await import('./ai')).testProvider(provider); setProviderState('连接成功') } catch (error) { setProviderState(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) } }}>测试连接</button><button className="primary-button" onClick={() => setSettingsOpen(false)}>完成</button></div></div> : settingsTab === 'device' ? <><DeviceSettings/><div className="modal-actions"><button className="primary-button" onClick={() => setSettingsOpen(false)}>完成</button></div></> : <><ThemeSettings selected={theme} onSelect={setTheme}/><div className="modal-actions"><button className="primary-button" onClick={() => setSettingsOpen(false)}>完成</button></div></>}</div></div>}
  </div>
}
