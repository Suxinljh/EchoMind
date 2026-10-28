import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Cloud, Coins, Download, ExternalLink, FileText, GitBranch, LockKeyhole, Mic, Pause, Play, Plus, RotateCcw, Settings2, ShieldCheck, SkipForward, Sparkles, Square, Target, UserRound, X } from 'lucide-react'
import { fetchAccount, takeAuthNotice, type AccountUser } from './account'
import { newestFirst, sanitizeSession } from './sessionUtils'
import { resetSyncCursor, syncHistory } from './sync'
import { localEvaluation, offlineTasks, overallScore, questionScore, reportStats, speechStats, tentativeFillers, transcriptParagraphs } from './logic'
import { captureReportAppearance, createReportHtml } from './reportExport'
import DeviceSettings from './DeviceSettings'
import ModelSettings from './ModelSettings'
import { CREDITS_CHANGED, KIND_LABELS, fetchCredits, fetchUsage, parseCustomCredits, type UsageLog } from './credits'
import { loadAi } from './chunkLoad'
import type { ModelMode } from './modelMode'
import Logo from './Logo'
import SemanticEditor from './SemanticEditor'
import packageJson from '../package.json'
import ThemeSettings from './ThemeSettings'
import { readTheme, saveTheme, type ThemeId } from './themes'
import type { Answer, InterviewSettings, Mode, Provider, ReportSettings, Session, Stage, Task } from './types'
import { useRecorder } from './useRecorder'
import './styles.css'
import './theme.css'
import './ui.css'
import './report.css'

const initialInterview: InterviewSettings = { position: '', jd: '', questionCount: 5, includeIntro: true, includeCandidate: true }
const initialReport: ReportSettings = { topic: '', audience: '', purpose: '同步进展', secondaryPurpose: '', outline: '' }
const initialProvider: Provider = { baseUrl: '', apiKey: '', model: '' }
const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const LEGACY_HISTORY_KEY = 'echomind-practice-history-v1'
const ANONYMOUS_HISTORY_KEY = 'echomind-history-v2:anonymous'
const LEGACY_MOVED_KEY = 'echomind-history-v2:legacy-moved'
const historyKeyFor = (sub?: string) => sub ? `echomind-history-v2:user:${sub}` : ANONYMOUS_HISTORY_KEY
const migrationFlagKey = (sub: string) => `echomind-history-v2:migrated:${sub}`
function writeHistory(key: string, value: Session[]) { localStorage.setItem(key, JSON.stringify(value)) }
function ensureLegacyHistory() {
  try {
    if (localStorage.getItem(LEGACY_MOVED_KEY)) return
    if (localStorage.getItem(ANONYMOUS_HISTORY_KEY) === null) {
      const legacy = localStorage.getItem(LEGACY_HISTORY_KEY)
      if (legacy) localStorage.setItem(ANONYMOUS_HISTORY_KEY, legacy)
    }
    localStorage.setItem(LEGACY_MOVED_KEY, '1')
  } catch { /* 迁移失败时保持原状，不阻塞应用启动。 */ }
}
const providerKey = 'echomind-model-config-v1'
const HISTORY_WRITE_DELAY_MS = 500
function historyState(item: Session): string {
  if (item.tasks.length === 0 || item.current >= item.tasks.length) return '已完成'
  if (!item.answers.some(answer => answer.status === 'answered')) return '未开始'
  return `继续 · ${item.current}/${item.tasks.length} 环节`
}

function readHistory(key: string): Session[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(value)) return []
    return newestFirst(value.map(sanitizeSession).filter((item): item is Session => item !== null))
  } catch { return [] }
}
const modelModeKey = 'echomind-model-mode-v1'
function readModelMode(): ModelMode { try { return localStorage.getItem(modelModeKey) === 'platform' ? 'platform' : 'own' } catch { return 'own' } }
function readProvider(): Provider { try { return { ...initialProvider, ...JSON.parse(localStorage.getItem(providerKey) || '{}'), apiKey: sessionStorage.getItem('echomind-api-key') || '' } } catch { return initialProvider } }

export default function App() {
  const [mode, setMode] = useState<Mode>('interview')
  const [stage, setStage] = useState<Stage>('home')
  const [interview, setInterview] = useState(initialInterview)
  const [report, setReport] = useState(initialReport)
  const [provider, setProvider] = useState(readProvider)
  const [modelMode, setModelMode] = useState<ModelMode>(readModelMode)
  const [historyKey, setHistoryKey] = useState(ANONYMOUS_HISTORY_KEY)
  const [history, setHistory] = useState<Session[]>(() => { ensureLegacyHistory(); return readHistory(ANONYMOUS_HISTORY_KEY) })
  const [migration, setMigration] = useState<Session[] | null>(null)
  const [modePickerOpen, setModePickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'model' | 'device' | 'theme'>('model')
  const [theme, setTheme] = useState<ThemeId>(readTheme)
  const [privacyConsent, setPrivacyConsent] = useState(() => sessionStorage.getItem('echomind-model-consent') === 'yes')
  const [session, setSession] = useState<Session | null>(null)
  const [pending, setPending] = useState<{ raw: string; segments: string[]; semantic: string; semanticEdited: boolean; duration: number; events: Answer['events'] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [account, setAccount] = useState<AccountUser | null>(null)
  const [accountReady, setAccountReady] = useState(false)
  const [accountChecked, setAccountChecked] = useState(false)
  const [anonymousCount, setAnonymousCount] = useState(0)
  const [credits, setCredits] = useState<number | null>(null)
  const [platformConfigured, setPlatformConfigured] = useState(false)
  const [creditsManaged, setCreditsManaged] = useState(false)
  const [creditsOpen, setCreditsOpen] = useState(false)
  // 从账号中心带过来的待充值额度，交给模型设置预填。
  const [rechargePrefill, setRechargePrefill] = useState<number | null>(null)
  const [usageLogs, setUsageLogs] = useState<UsageLog[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle')
  const syncingRef = useRef(false)
  const syncAgainRef = useRef(false)
  const syncRetryTimer = useRef<number | null>(null)
  const skipNextSyncRef = useRef(false)
  const largeSyncNotified = useRef(false)
  const [selectedResult, setSelectedResult] = useState(0)
  const historyTimer = useRef<number | null>(null)
  const historyRef = useRef(history)
  const historyKeyRef = useRef(historyKey)
  const historyFailed = useRef(false)
  // 标识当前练习；录音收尾是异步的，切换练习后不能再把旧结果写进新练习。
  const practiceToken = useRef(0)
  // 在途模型调用的中止句柄；切换练习或语义稿变化后旧结果不能再写回。
  const reportAbortRef = useRef<AbortController | null>(null)
  // 创建当前待确认回答时的转写序号；用于识别收尾超时后才到达的最终结果。
  const pendingSeqRef = useRef(0)
  const sessionRef = useRef(session)
  historyRef.current = history
  historyKeyRef.current = historyKey
  sessionRef.current = session
  const recorder = useRecorder(stage === 'practice')
  const task = session?.tasks[session.current]
  const platformReady = modelMode === 'platform' && accountReady && !!account && platformConfigured && (credits ?? 0) > 0
  // 登录服务可用但未登录：开始/继续练习前先登录。登录未配置时保持本地兜底。
  const loginRequired = accountChecked && accountReady && !account
  const readyForAI = modelMode === 'own' ? !!provider.baseUrl && !!provider.model && privacyConsent : platformReady
  const results = useMemo(() => session?.tasks.map(t => ({ task: t, answer: session.answers.find(a => a.taskId === t.id) })) || [], [session])
  const summaryStats = useMemo(() => session ? reportStats(session) : null, [session])
  const totalScore = session ? overallScore(session) : null
  const needsAnalysis = !!session && session.answers.some(a => a.status === 'answered') && (session.answers.some(a => a.status === 'answered' && a.evaluation?.source !== 'ai') || !session.overallAnalysis)
  const liveText = recorder.final + recorder.interim
  const liveStats = useMemo(() => speechStats(pending?.raw || liveText), [pending?.raw, liveText])
  const liveParagraphs = useMemo(() => transcriptParagraphs(pending?.segments || [...recorder.segments, recorder.interim]), [pending?.segments, recorder.segments, recorder.interim])

  useEffect(() => { localStorage.setItem(providerKey, JSON.stringify({ baseUrl: provider.baseUrl, model: provider.model })); sessionStorage.setItem('echomind-api-key', provider.apiKey) }, [provider])
  // 登录是可选的：没登录时接口返回 null，界面保持原样。
  useEffect(() => {
    const controller = new AbortController()
    void fetchAccount(controller.signal).then(state => { setAccount(state.user); setAccountReady(state.available); setAccountChecked(true) })
    return () => controller.abort()
  }, [])
  // 从账号中心登出后按浏览器“后退”可能命中 bfcache，恢复页面时重新确认登录态。
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      const controller = new AbortController()
      void fetchAccount(controller.signal).then(state => { setAccount(state.user); setAccountReady(state.available); setAccountChecked(true) })
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])
  useEffect(() => {
    if (!account) { setCredits(null); setPlatformConfigured(false); return }
    const controller = new AbortController()
    const apply = (info: { balance: number; configured: boolean; managed?: boolean } | null) => {
      if (!info) return
      setCredits(info.balance)
      setPlatformConfigured(info.configured)
      setCreditsManaged(Boolean(info.managed))
    }
    void fetchCredits(controller.signal).then(apply)
    const refresh = () => { void fetchCredits().then(apply) }
    window.addEventListener(CREDITS_CHANGED, refresh)
    return () => { controller.abort(); window.removeEventListener(CREDITS_CHANGED, refresh) }
  }, [account])

  async function openCredits() {
    setCreditsOpen(true)
    setUsageLoading(true)
    const data = await fetchUsage()
    if (data) { setCredits(data.balance); setUsageLogs(data.logs); setCreditsManaged(Boolean(data.managed)) }
    setUsageLoading(false)
  }

  // 登录回跳提示放在 effect 里读取，避免在渲染期间改地址栏。
  useEffect(() => { const text = takeAuthNotice(); if (text) setNotice(text) }, [])
  // 支付回跳结果；最终状态仍以服务端异步通知/查询为准。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const pay = params.get('pay')
    // 账号中心/其它入口可以用 ?recharge=<积分> 直接打开充值区，预填自定义额度。
    const recharge = parseCustomCredits(params.get('recharge'))
    if (params.has('recharge') || recharge !== null) {
      params.delete('recharge')
      const query = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
      if (recharge !== null) { setRechargePrefill(recharge); setSettingsTab('model'); setSettingsOpen(true) }
    }
    if (!pay) return
    if (pay === 'success') window.dispatchEvent(new Event(CREDITS_CHANGED))
    setNotice(pay === 'success' ? '支付成功，积分已到账。' : pay === 'pending' ? '支付结果确认中，请稍后查看积分。' : '支付结果校验失败，未入账。')
    params.delete('pay')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
  }, [])
  // 从账号中心带着充值额度过来但还没登录：先去登录，回跳后仍然保留额度。
  useEffect(() => {
    if (!rechargePrefill || !accountChecked || !accountReady || account) return
    window.location.replace(`/auth/login?returnTo=${encodeURIComponent(`/?recharge=${rechargePrefill}`)}`)
  }, [rechargePrefill, accountChecked, accountReady, account])
  // 练习历史按账号隔离：登录后切到该 sub 的存储，退出后回到匿名存储。
  useEffect(() => {
    if (!accountReady) return
    const nextKey = historyKeyFor(account?.sub)
    setHistoryKey(nextKey)
    setHistory(readHistory(nextKey))
    const anonymous = readHistory(ANONYMOUS_HISTORY_KEY)
    setAnonymousCount(anonymous.length)
    if (account) {
      if (anonymous.length && !localStorage.getItem(migrationFlagKey(account.sub))) setMigration(anonymous)
      else setMigration(null)
    } else {
      setMigration(null)
    }
  }, [accountReady, account?.sub])

  async function runSync(manual = false) {
    if (!account) return
    // 正在同步时记下“还需要再同步一次”，避免本地编辑被这次请求的快照漏掉。
    if (syncingRef.current) { syncAgainRef.current = true; return }
    if (historyKey !== historyKeyFor(account.sub)) return
    syncingRef.current = true
    setSyncState('syncing')
    const snapshot = historyRef.current
    try {
      const result = await syncHistory(account.sub, snapshot)
      if (!result.sessions) {
        setSyncState('error')
        if (manual && result.error) setNotice(`同步失败：${result.error}`)
        return
      }
      if (result.skipped && !largeSyncNotified.current) {
        largeSyncNotified.current = true
        setNotice(`有 ${result.skipped} 条练习超过 1.9MB，仅保存在本机，未同步到其他设备。`)
      }
      // 同步期间本地有编辑：不能用旧快照的合并结果覆盖，改为基于最新历史再同步一次。
      // 本次已保存的游标可能越过了被丢弃的远端结果，重置游标让下一次重新拉取。
      if (historyRef.current !== snapshot) {
        if (result.previousCursor) resetSyncCursor(account.sub, result.previousCursor, historyRef.current.map(item => item.createdAt))
        syncAgainRef.current = true
        return
      }
      if (result.changed) {
        skipNextSyncRef.current = true
        setHistory(result.sessions)
      }
      setSyncState('synced')
    } catch (error) {
      setSyncState('error')
      if (manual) setNotice(`同步失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      syncingRef.current = false
      if (syncAgainRef.current) {
        syncAgainRef.current = false
        syncRetryTimer.current = window.setTimeout(() => {
          syncRetryTimer.current = null
          void runSync()
        }, 0)
      }
    }
  }

  // 登录后自动同步，不提供关闭开关；窗口重新聚焦和每 60 秒会再拉取一次。
  useEffect(() => {
    if (!account || !accountReady) { setSyncState('idle'); return }
    if (historyKey !== historyKeyFor(account.sub)) return
    void runSync()
    const timer = window.setInterval(() => { void runSync() }, 60_000)
    const onFocus = () => { void runSync() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      syncAgainRef.current = false
      if (syncRetryTimer.current !== null) { window.clearTimeout(syncRetryTimer.current); syncRetryTimer.current = null }
    }
  }, [account?.sub, accountReady, historyKey])

  // 本地历史变化后延迟推送，避免连续编辑时频繁请求。
  useEffect(() => {
    if (!account || historyKey !== historyKeyFor(account.sub)) return
    if (skipNextSyncRef.current) { skipNextSyncRef.current = false; return }
    const timer = window.setTimeout(() => { void runSync() }, 1500)
    return () => window.clearTimeout(timer)
  }, [history])

  function importAnonymousHistory() {
    if (!account || !migration) return
    const key = historyKeyFor(account.sub)
    const existing = readHistory(key)
    const merged = newestFirst([
      ...migration,
      ...existing.filter(item => !migration.some(anonymous => anonymous.createdAt === item.createdAt)),
    ])
    try {
      writeHistory(key, merged)
    } catch {
      setNotice('浏览器存储空间不足，导入失败。')
      return
    }
    localStorage.removeItem(ANONYMOUS_HISTORY_KEY)
    localStorage.setItem(migrationFlagKey(account.sub), '1')
    setAnonymousCount(0)
    if (historyKey === key) setHistory(merged)
    setMigration(null)
    setNotice(`已导入 ${migration.length} 条本机练习。`)
  }

  function skipAnonymousHistory() {
    if (account) localStorage.setItem(migrationFlagKey(account.sub), '1')
    setMigration(null)
  }

  useEffect(() => { sessionStorage.setItem('echomind-model-consent', privacyConsent ? 'yes' : 'no') }, [privacyConsent])
  useEffect(() => { try { localStorage.setItem(modelModeKey, modelMode) } catch { /* 仅影响本机记忆，不影响当前使用。 */ } }, [modelMode])
  useEffect(() => { document.documentElement.dataset.theme = theme; saveTheme(theme) }, [theme])
  useEffect(() => { if (!session) return; setHistory(current => newestFirst([session, ...current.filter(item => item.createdAt !== session.createdAt)])) }, [session])
  // 写入 localStorage 放在 effect 主体内防抖，避免在 setState 更新函数里做副作用（StrictMode 会执行两次）。
  useEffect(() => {
    if (!history.length) return
    if (historyTimer.current !== null) window.clearTimeout(historyTimer.current)
    historyTimer.current = window.setTimeout(() => {
      historyTimer.current = null
      try {
        localStorage.setItem(historyKey, JSON.stringify(history))
        if (historyFailed.current) { historyFailed.current = false; setNotice('练习历史已恢复保存。') }
      } catch { historyFailed.current = true; setNotice('浏览器存储空间不足，练习历史未保存。') }
    }, HISTORY_WRITE_DELAY_MS)
    return () => { if (historyTimer.current !== null) { window.clearTimeout(historyTimer.current); historyTimer.current = null } }
  }, [history, historyKey])
  useEffect(() => () => {
    if (historyTimer.current === null) return
    window.clearTimeout(historyTimer.current); historyTimer.current = null
    try { localStorage.setItem(historyKeyRef.current, JSON.stringify(historyRef.current)) } catch { /* 忽略：卸载时的兜底写入失败不影响后续使用。 */ }
  }, [])
  // 页面跳转/关闭时立即落盘，避免防抖窗口内的练习记录丢失（例如练完立刻去登录）。
  useEffect(() => {
    const flush = () => {
      if (historyTimer.current !== null) { window.clearTimeout(historyTimer.current); historyTimer.current = null }
      try { localStorage.setItem(historyKeyRef.current, JSON.stringify(historyRef.current)) } catch { /* 忽略 */ }
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])
  // 练习变化或组件卸载时中止在途的模型调用，既避免旧结果写回新练习，也避免继续计费。
  useEffect(() => () => { cancelReportEvaluation() }, [session?.createdAt])
  // 收尾/重新转写超过兜底时间后，工作线程仍可能补发最终结果；合并回当前待确认回答，避免丢字。
  useEffect(() => {
    if (!pending || recorder.finishedSeq <= pendingSeqRef.current) return
    pendingSeqRef.current = recorder.finishedSeq
    const raw = recorder.final
    const segments = recorder.segments.length ? recorder.segments : raw ? [raw] : []
    const changed = raw !== pending.raw
    setPending(current => current ? {
      ...current,
      raw,
      segments,
      semantic: current.semanticEdited ? current.semantic : transcriptParagraphs(segments.length ? segments : [raw]).join('\n\n'),
    } : current)
    if (changed) setNotice('转写结果已更新，请核对语义稿。')
  }, [recorder.finishedSeq])

  // 开始练习前必须登录；登录服务未配置（本地预览/接口不可用）时保留本地练习兜底。
  function requireLogin(): boolean {
    if (!accountChecked) { setNotice('正在确认登录状态，请稍候…'); return false }
    if (!accountReady || account) return true
    window.location.href = '/auth/login?returnTo=/'
    return false
  }

  async function createSession() {
    if (!requireLogin()) return
    setNotice('')
    if (mode === 'interview' && (!interview.position.trim() || !interview.jd.trim())) { setNotice('请填写岗位和 JD。'); return }
    if (mode === 'report' && (!report.topic.trim() || !report.audience.trim() || !report.purpose.trim())) { setNotice('请填写汇报主题、听众和主要目的。'); return }
    setBusy(true)
    let tasks: Task[]
    if (mode === 'interview' && readyForAI) {
      try { tasks = await (await loadAi()).planInterview(provider, interview, modelMode) }
      catch (error) { tasks = offlineTasks(mode, interview); setNotice(`AI 出题失败，已使用基础问题：${error instanceof Error ? error.message : String(error)}`) }
    } else tasks = offlineTasks(mode, mode === 'interview' ? interview : report)
    setSession({ mode, tasks, answers: [], current: 0, settings: mode === 'interview' ? { ...interview } : { ...report }, createdAt: new Date().toISOString() })
    practiceToken.current += 1
    cancelReportEvaluation()
    recorder.reset()
    setStage('practice'); setPending(null); setBusy(false)
  }

  async function stopRecording() {
    const token = practiceToken.current
    pendingSeqRef.current = recorder.finishedSeq
    const result = await recorder.finish()
    // 收尾有超时兜底，返回时练习可能已被切换；此时不能把旧结果写成新练习的待确认回答。
    if (token !== practiceToken.current) { setNotice('练习已切换，本次录音结果未写入。'); return }
    setPending({ raw: result.raw, segments: result.segments, semantic: transcriptParagraphs(result.segments.length ? result.segments : [result.raw]).join('\n\n'), semanticEdited: false, duration: result.duration, events: result.events })
    if (!result.raw.trim()) setNotice(recorder.peakLevel < 4 ? '未识别到文字，且麦克风输入电平很低。请检查下方麦克风设备，换一个设备后重录。' : '录到了麦克风信号，但模型没有输出文字。请先点“重新转写”；仍为空可换麦克风重录。')
  }

  async function retryPendingTranscription() {
    if (!pending) return
    setBusy(true)
    pendingSeqRef.current = recorder.finishedSeq
    setNotice('正在重新转写，长录音可能需要几分钟，请保持页面打开。')
    try {
      const result = await recorder.retryTranscription()
      setPending(current => current ? {
        ...current,
        raw: result.raw,
        segments: result.segments,
        semantic: current.semanticEdited ? current.semantic : transcriptParagraphs(result.segments.length ? result.segments : [result.raw]).join('\n\n'),
      } : current)
      setNotice(result.raw.trim() ? '重新转写完成。请核对语义稿。' : '重新转写仍为空。请切换麦克风设备并重录；当前回答不会被确认。')
    } catch (error) {
      setNotice(`重新转写失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
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
    setSession(next); setPending(null); setNotice(''); recorder.reset()
    if (next.current >= next.tasks.length) { setStage('results'); setSelectedResult(0) }
    if (status === 'answered' && readyForAI) void runEvaluation(next, answer)
  }

  function cancelReportEvaluation() {
    const controller = reportAbortRef.current
    if (!controller) return
    reportAbortRef.current = null
    controller.abort()
  }

  // 写回前用当前会话核对：原练习已被切换、或语义稿已被改写时，明确告知而不是悄悄丢弃结果。
  function evaluationTargetChanged(target: Session, answer: Answer): boolean {
    if (sessionRef.current?.createdAt !== target.createdAt) { setNotice('原练习已切换，本次评估结果未写回。'); return true }
    const fresh = sessionRef.current.answers.find(saved => saved.taskId === answer.taskId)
    if (!fresh || fresh.semantic !== answer.semantic) { setNotice('语义稿已修改，本次评估结果未写回，请重新评估。'); return true }
    return false
  }

  async function runEvaluation(target: Session, answer: Answer) {
    const item = target.tasks.find(t => t.id === answer.taskId)
    if (!item || !readyForAI) return
    cancelReportEvaluation()
    const controller = new AbortController()
    reportAbortRef.current = controller
    try {
      const evaluation = await (await loadAi()).evaluate(provider, item, answer, target.settings, controller.signal, modelMode)
      if (evaluationTargetChanged(target, answer)) return
      setSession(current => current?.createdAt === target.createdAt ? { ...current, overallAnalysis: undefined, answers: current.answers.map(a => a.taskId === answer.taskId && a.semantic === answer.semantic ? { ...a, evaluation } : a) } : current)
    } catch (error) {
      if (controller.signal.aborted) { setNotice('已取消本次评估。'); return }
      setNotice(`评估失败：${error instanceof Error ? error.message : String(error)}。回答已保存，可在报告中重试。`)
    } finally { if (reportAbortRef.current === controller) reportAbortRef.current = null }
  }

  function editSemantic(taskId: string, value: string) {
    setSession(current => {
      if (!current) return current
      const item = current.tasks.find(t => t.id === taskId)
      if (!item) return current
      return { ...current, overallAnalysis: undefined, answers: current.answers.map(a => a.taskId === taskId ? { ...a, semantic: value, evaluation: localEvaluation(item, { ...a, semantic: value }) } : a) }
    })
  }

  function startNew(mode: Mode) { if (!requireLogin()) { setModePickerOpen(false); return } practiceToken.current += 1; cancelReportEvaluation(); recorder.reset(); setMode(mode); setSession(null); setPending(null); setStage('setup'); setNotice(''); setModePickerOpen(false) }
  function openHistory(item: Session) {
    const complete = item.tasks.length === 0 || item.current >= item.tasks.length
    // 已完成练习可以直接回看报告；继续未完成的练习前必须登录。
    if (!complete && !requireLogin()) return
    practiceToken.current += 1
    cancelReportEvaluation()
    recorder.reset()
    setSession(item); setMode(item.mode); setPending(null); setSelectedResult(0)
    setStage(complete ? 'results' : 'practice')
    setNotice(complete ? '' : `已打开 ${new Date(item.createdAt).toLocaleDateString('zh-CN')} 的练习，从第 ${item.current + 1} 环节继续。`)
  }

  async function evaluateReport() {
    if (!session) return
    if (!readyForAI) { setSettingsOpen(true); return }
    cancelReportEvaluation()
    const controller = new AbortController()
    reportAbortRef.current = controller
    setBusy(true)
    // 只补全还没有 AI 评价的题目，避免重复计费。
    const targets = session.answers.filter(item => item.status === 'answered' && item.semantic.trim() && item.evaluation?.source !== 'ai')
    let failures = 0
    let firstError = ''
    const updatedAnswers = [...session.answers]
    const writeAnswer = (answer: Answer, evaluation: Answer['evaluation']) => {
      if (evaluationTargetChanged(session, answer)) return
      setSession(current => current?.createdAt === session.createdAt ? { ...current, answers: current.answers.map(saved => saved.taskId === answer.taskId && saved.semantic === answer.semantic ? { ...saved, evaluation } : saved) } : current)
    }
    try {
      for (const [index, answer] of targets.entries()) {
        const item = session.tasks.find(task => task.id === answer.taskId)
        if (!item) continue
        setNotice(`正在评估 ${index + 1}/${targets.length}…`)
        try {
          const evaluation = await (await loadAi()).evaluate(provider, item, answer, session.settings, controller.signal, modelMode)
          const position = updatedAnswers.findIndex(saved => saved.taskId === answer.taskId)
          if (position >= 0) updatedAnswers[position] = { ...answer, evaluation }
          writeAnswer(answer, evaluation)
        } catch (error) { failures++; if (!firstError) firstError = error instanceof Error ? error.message : String(error) }
        if (controller.signal.aborted) { setNotice('已取消本次评估。'); return }
      }
      if (!failures && updatedAnswers.some(answer => answer.status === 'answered')) {
        setNotice('正在生成整场分析…')
        try {
          const overallAnalysis = await (await loadAi()).analyzeSession(provider, { ...session, answers: updatedAnswers }, controller.signal, modelMode)
          if (sessionRef.current?.createdAt === session.createdAt) setSession(current => current?.createdAt === session.createdAt ? { ...current, overallAnalysis } : current)
          else setNotice('原练习已切换，整场分析未写回。')
        } catch (error) { failures++; firstError = error instanceof Error ? error.message : String(error) }
      }
    } finally {
      if (reportAbortRef.current === controller) reportAbortRef.current = null
      setBusy(false)
    }
    if (controller.signal.aborted) { setNotice('已取消本次评估。'); return }
    setNotice(failures ? `报告有 ${failures} 处未完成：${firstError}` : '分析报告已更新。')
  }

  function exportReport(open: boolean) {
    if (!session) return
    const url = URL.createObjectURL(new Blob([createReportHtml(session, captureReportAppearance(theme))], { type: 'text/html;charset=utf-8' }))
    if (open) {
      // 指定 noopener 时 window.open 按规范一定返回 null，无法据此判断是否被拦截。
      const tab = window.open(url, '_blank')
      if (tab) tab.opener = null
      else setNotice('浏览器拦截了新标签页，请使用下载。')
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
      <div className="top-right">{account ? <button type="button" className={`sync-chip ${syncState}`} onClick={() => void runSync(true)} title="练习记录会自动同步到当前账号"><Cloud size={14}/> {syncState === 'syncing' ? '同步中' : syncState === 'error' ? '同步失败' : '已同步'}</button> : null}{account && credits !== null ? <button type="button" className="credits-chip" onClick={openCredits}><Coins size={14}/> {credits} 积分</button> : null}{accountReady ? (account ? <span className="account-chip" title={account.email || account.name}><span className="account-avatar" aria-hidden="true">{(account.name || account.email || 'S').slice(0, 1).toUpperCase()}</span><span className="account-name">{account.name || account.email}</span><a className="account-action" href="/auth/logout">退出</a></span> : <a className="account-login" href="/auth/login?returnTo=/"><UserRound size={15}/> 登录</a>) : null}<span className="privacy-chip"><ShieldCheck size={15}/> 仅本地录音</span><button className="icon-button" aria-label="模型设置" onClick={() => setSettingsOpen(true)}><Settings2 size={19}/></button></div>
    </header>
    <div className="layout">
      <aside className="sidebar">
        {loginRequired ? <a className="new-practice-button" style={{ textDecoration: 'none' }} href="/auth/login?returnTo=/"><UserRound size={18}/> 登录后开始练习</a> : <button className="new-practice-button" onClick={() => setModePickerOpen(true)}><Plus size={18}/> 新建练习</button>}
        <div className="sidebar-divider"/>
        <div className="sidebar-label">练习历史</div>
        {history.length === 0 ? <div className="empty-history">{loginRequired ? '登录后开始第一次练习' : '没有历史，快速开始'}</div> : <div className="history-list">{history.map(item => <button key={item.createdAt} className={`history-item ${session?.createdAt === item.createdAt ? 'active' : ''}`} onClick={() => openHistory(item)}><span className="history-icon">{item.mode === 'interview' ? <Target size={16}/> : <FileText size={16}/>}</span><span><strong>{item.mode === 'interview' ? (item.settings as InterviewSettings).position || '模拟面试' : (item.settings as ReportSettings).topic || '工作汇报'}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {historyState(item)}</small></span></button>)}</div>}
        {account && anonymousCount > 0 ? <button type="button" className="import-history" onClick={() => { const items = readHistory(ANONYMOUS_HISTORY_KEY); setAnonymousCount(items.length); if (items.length) setMigration(items) }}>本机还有 {anonymousCount} 条未登录练习 · 导入</button> : null}
        <div className="sidebar-meta"><a className="sidebar-link" href="/changelog"><BookOpen size={17}/> 更新日志 <ChevronRight size={14}/></a><a className="sidebar-link" href="https://github.com/Suxinljh/EchoMind" target="_blank" rel="noopener noreferrer"><GitBranch size={17}/> GitHub <ExternalLink size={14}/></a><div className="sidebar-bottom"><div className="sidebar-bottom-head"><ShieldCheck size={20}/><strong>隐私优先</strong></div><p>音频在浏览器内处理。开始练习需要登录，练习记录保存在 Suxin 账号（本机有缓存，不含音频）。启用模型后才会发送指定文字。</p></div></div>
      </aside>
      <main className="main-area">
        {stage === 'home' && <div className="home-page"><h1>把想法，说得更清楚。</h1><p className="hero-copy">{loginRequired ? '登录 Suxin 账号后即可开始练习。练习记录会保存到账号并在设备间同步；音频仍只在本机处理。' : '选择一个真实场景，开始练习表达。录音会在本机转录，完成后可回看报告。'}</p>{loginRequired ? <a className="primary-button" style={{ textDecoration: 'none' }} href="/auth/login?returnTo=/"><UserRound size={17}/> 登录后开始练习</a> : <button className="primary-button" onClick={() => setModePickerOpen(true)}><Plus size={17}/> 新建练习</button>}</div>}
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
          <section className="setup-model-row"><div className="model-notice"><Sparkles size={17}/><div><strong>{readyForAI ? '已填写模型配置' : modelMode === 'platform' ? (!platformConfigured ? '平台模型未配置' : (credits ?? 0) <= 0 ? '积分不足' : '平台模型未就绪') : '可先用基础问题练习'}</strong><span>{readyForAI ? (modelMode === 'platform' ? '开始后会按 token 扣减积分生成问题并评估文字。' : '开始后会调用你设置的模型生成问题并评估文字。') : modelMode === 'platform' ? (!platformConfigured ? '管理员配置平台模型后即可使用；当前先使用基础问题。' : (credits ?? 0) <= 0 ? '请先在设置中充值积分；当前先使用基础问题。' : '登录后可查看积分并使用平台模型。') : '连接自备模型后，可获得针对 JD 的问题和证据化反馈。'}</span></div></div><button className="secondary-button" onClick={() => setSettingsOpen(true)}>模型设置 <ArrowRight size={14}/></button></section>
        </div>}
        {stage === 'practice' && session && task && <div className="practice-page">
          <div className="page-topline"><button className="text-button" onClick={() => setModePickerOpen(true)}><ArrowLeft size={16}/> 新练习</button><span>环节 {session.current + 1} / {session.tasks.length}</span></div>
          <div className="practice-heading"><div><h1>{task.title}</h1></div></div>
          <div className="practice-grid"><div className="practice-primary">
            <section className="card question-card"><div className="question-label"><span className="question-number">{String(session.current + 1).padStart(2, '0')}</span> 当前任务</div><h2>{task.prompt}</h2>{task.jdEvidence && <div className="jd-evidence">JD 依据：{task.jdEvidence}</div>}</section>
            <section className="card recording-card"><div className="record-top"><div><h3>你的回答</h3></div><span className={`record-indicator ${recorder.status === 'recording' ? 'live' : ''}`}><span/> {recorder.status === 'recording' ? '录音中' : recorder.status === 'paused' ? '已暂停' : pending ? '待确认' : '待录音'}</span></div>
              <div className="transcript-area">{pending ? <><div className="transcript-label">原始转写 · 自动分段 · 确认后锁定</div><div className="transcript-paragraphs">{liveParagraphs.length ? liveParagraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>) : <p className="empty-transcript">未识别到文字</p>}</div><label className="field semantic-field">语义稿 · 可修正识别错误<textarea rows={6} value={pending.semantic} onChange={e => setPending({ ...pending, semantic: e.target.value, semanticEdited: true })} placeholder="修正 ASR 错字，保留真实语义"/></label></> : <><div className="transcript-label">实时转录 · 自动分段</div><div className="transcript-paragraphs">{liveParagraphs.length ? liveParagraphs.map((paragraph, i) => <p key={i} className={i === liveParagraphs.length - 1 && recorder.interim ? 'interim' : ''}>{paragraph}</p>) : <p className="empty-transcript">开始录音后，文字会出现在这里…</p>}</div></>}</div>
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
              {recorder.recorderNotice && <div className="audio-warning"><CircleHelp size={15}/> {recorder.recorderNotice}</div>}
              {recorder.signalWarning && recorder.status === 'recording' && <div className="audio-warning"><CircleHelp size={15}/> 连续 4 秒没有检测到明显的麦克风输入。请检查 Chrome 的麦克风权限和当前输入设备。</div>}
              {recorder.status === 'recording' && recorder.duration - recorder.processedSeconds > 8 && <div className="audio-warning"><CircleHelp size={15}/> 语音模型处理落后录音超过 8 秒。可以先结束回答，等待剩余音频处理完成。</div>}
              {pending && !pending.raw.trim() && <div className="audio-warning"><CircleHelp size={15}/> 本次原始转写为空。可重新处理已录制音频，或选择麦克风后重录。请不要直接确认空白回答。</div>}
              {pending && recorder.status === 'finishing' && recorder.finishTimedOut && <div className="audio-warning"><CircleHelp size={15}/> 转写超时，已显示当前结果。可先确认回答，或等待模型完成。</div>}
              {recorder.silenceHint && <div className="silence-hint"><CircleHelp size={15}/> 已持续停顿超过 3 秒。可以先说结论或下一步。</div>}
              <div className="record-controls"><div className="timer"><span className={recorder.status === 'recording' ? 'pulse-dot' : ''}/>{formatTime(pending?.duration ?? recorder.duration)} <small>有效时长</small></div><div className="control-actions">{!pending && recorder.status === 'ready' && <button className="primary-button" disabled={recorder.deviceBusy} onClick={recorder.start}><Mic size={17}/> 开始录音</button>}{!pending && recorder.status === 'recording' && <><button className="secondary-button" onClick={recorder.pause}><Pause size={17}/> 暂停</button><button className="primary-button" onClick={stopRecording}><Square size={15}/> 结束回答</button></>}{!pending && recorder.status === 'paused' && <><button className="secondary-button" onClick={recorder.resume}><Play size={17}/> 继续</button><button className="primary-button" onClick={stopRecording}><Square size={15}/> 结束回答</button></>}{recorder.status === 'loading' && <span className="muted">{recorder.detail}…</span>}{recorder.status === 'finishing' && <span className="muted">正在收尾转写…</span>}{recorder.status === 'error' && <><span className="error-text">语音模型错误：{recorder.detail}</span><button className="secondary-button" onClick={recorder.reset}>重试语音模型</button></>}</div></div>
            </section>
            {pending && !pending.raw.trim() && <div className="recovery-actions"><button className="secondary-button" disabled={busy || recorder.status === 'finishing' || recorder.status === 'error'} onClick={retryPendingTranscription}><RotateCcw size={16}/> 重新转写已录音频</button><button className="secondary-button" disabled={busy || recorder.status === 'finishing'} onClick={() => { setPending(null); setNotice('已清除失败的录音。切换麦克风后请重新录制。') }}><Mic size={16}/> 重录这一题</button></div>}
            {pending && pending.raw.trim() && <div className="confirm-panel"><LockKeyhole size={18}/><p>确认后此回答不可重录，原始转写也不能修改。语义稿可在报告中继续修订。</p><button className="primary-button" onClick={() => commitAnswer('answered')}><Check size={17}/> 确认回答 <ArrowRight size={17}/></button></div>}
            {!pending && recorder.status !== 'recording' && recorder.status !== 'paused' && recorder.status !== 'finishing' && <button className="skip-button" onClick={() => commitAnswer('skipped')}><SkipForward size={16}/> 跳过本题</button>}
          </div><aside className="practice-aside"><div className="tip-card"><div className="tip-icon"><Sparkles size={18}/></div><h3>实时提示</h3><p>{recorder.silenceHint ? '停顿有些长，试着先说结论或下一步。' : '先讲核心结论，再用事实和行动支撑。'}</p></div><div className="analysis-card"><h3>需要留意的表达</h3><div className="stat-group-title">语气词</div>{Object.entries(liveStats.fillers).map(([word, count]) => <div key={word}><span>“{word}”</span><strong>{count} 次</strong></div>)}<div className="stat-group-title">重复连接词</div>{Object.entries(liveStats.transitions).map(([word, count]) => <div key={word}><span>“{word}”</span><strong>{count} 次</strong></div>)}<div className="stat-group-title">节奏</div><div><span>长停顿</span><strong>{recorder.events.filter(e => e.kind === 'silence').length} 次</strong></div><small>根据实时转录与音量估算，仅供练习参考。</small></div></aside></div>
        </div>}
        {stage === 'results' && session && <div className="results-page"><h1>练习报告</h1><p className="hero-copy">{session.mode === 'interview' ? '逐题查看回答、证据与下次练习建议。' : '回看完整汇报，检查目标、听众适配和内容覆盖。'}</p>{needsAnalysis && <div className="report-notice">{readyForAI ? '报告分析尚未完成。可根据已保存的语义稿补全。' : modelMode === 'platform' ? '平台模型内测中，当前报告只包含基础统计。' : '配置大模型后，可生成逐题与整场分析。'}</div>}
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
                  <label className="semantic-editor"><strong>语义稿 · 可修订</strong><SemanticEditor key={selected.answer.taskId} taskId={selected.answer.taskId} value={selected.answer.semantic} onChange={editSemantic}/></label>
                </div>
                {readyForAI && <div className="transcript-actions"><button className="secondary-button" onClick={() => runEvaluation(session, selected.answer!)}><RotateCcw size={15}/> 评估此版本</button></div>}
              </section><section className="metrics-note">语气词识别 {tentativeFillers(selected.answer.raw)} 次 · 长停顿 {selected.answer.events.filter(e => e.kind === 'silence').length} 次 · 有效时长 {formatTime(selected.answer.duration)}。这些指标仅供参考，不参与评分。</section></>}</div></div></div>}
        {notice && <div className="toast" role="alert"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
      </main>
    </div>
    {modePickerOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModePickerOpen(false) }}><div className="mode-modal" role="dialog" aria-modal="true" aria-label="选择练习类型"><div className="modal-head"><div><h2>选择练习类型</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setModePickerOpen(false)}><X size={20}/></button></div><p>选择场景后进入配置页面。</p><div className="mode-options"><button onClick={() => startNew('interview')}><Target size={22}/><span><strong>模拟面试</strong><small>根据岗位和 JD 练习逐题回答</small></span><ArrowRight size={17}/></button><button onClick={() => startNew('report')}><FileText size={22}/><span><strong>工作汇报</strong><small>围绕主题和听众练习连续表达</small></span><ArrowRight size={17}/></button></div></div></div>}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}><div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置"><div className="modal-head"><div><h2>设置</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setSettingsOpen(false)}><X size={20}/></button></div>
      <div className="settings-tabs" role="tablist" aria-label="设置类型"><button id="model-settings-tab" type="button" role="tab" aria-selected={settingsTab === 'model'} aria-controls="model-settings-panel" className={settingsTab === 'model' ? 'active' : ''} onClick={() => setSettingsTab('model')}>模型设置</button><button id="device-settings-tab" type="button" role="tab" aria-selected={settingsTab === 'device'} aria-controls="device-settings-panel" className={settingsTab === 'device' ? 'active' : ''} onClick={() => setSettingsTab('device')}>设备设置</button><button id="theme-settings-tab" type="button" role="tab" aria-selected={settingsTab === 'theme'} aria-controls="theme-settings-panel" className={settingsTab === 'theme' ? 'active' : ''} onClick={() => setSettingsTab('theme')}>主题风格</button></div>
      {settingsTab === 'model' ? <ModelSettings
        mode={modelMode}
        onModeChange={setModelMode}
        provider={provider}
        onProviderChange={setProvider}
        privacyConsent={privacyConsent}
        onPrivacyConsentChange={setPrivacyConsent}
        busy={busy}
        setBusy={setBusy}
        account={account}
        accountReady={accountReady}
        initialCredits={rechargePrefill}
        onDone={() => setSettingsOpen(false)}
      /> : settingsTab === 'device' ? <><DeviceSettings/><div className="modal-actions"><button className="primary-button" onClick={() => setSettingsOpen(false)}>完成</button></div></> : <><ThemeSettings selected={theme} onSelect={setTheme}/><div className="modal-actions"><button className="primary-button" onClick={() => setSettingsOpen(false)}>完成</button></div></>}</div></div>}
    {creditsOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setCreditsOpen(false) }}><div className="settings-modal credits-modal" role="dialog" aria-modal="true" aria-label="积分与用量">
      <div className="modal-head"><div><h2>积分与用量</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setCreditsOpen(false)}><X size={20}/></button></div>
      <div className="credits-summary"><div><strong>{credits ?? '—'}</strong><span>当前积分</span></div><div><strong>{usageLogs.reduce((sum, log) => sum + log.credits, 0)}</strong><span>最近消耗</span></div></div>
      {creditsManaged && <p className="credits-empty">积分跟随 Suxin 账号，可在接入的平台通用；充值在模型设置中完成，退款请到<a href="https://account.ljhsu.xin/refunds" target="_blank" rel="noreferrer">账号中心</a>。</p>}
      {!platformConfigured && <p className="credits-empty">平台模型尚未配置，暂时无法产生消耗记录。</p>}
      {usageLoading ? <div className="credits-empty">正在读取用量…</div> : usageLogs.length === 0 ? <p className="credits-empty">还没有平台模型调用记录。</p> : <div className="usage-list">{usageLogs.map(log => <div key={log.id} className="usage-row"><div className="usage-main"><strong>{KIND_LABELS[log.kind] || log.kind}</strong><small>{new Date(log.createdAt).toLocaleString('zh-CN')} · {log.model}</small></div><div className="usage-meta"><span>{log.inputTokens.toLocaleString()} + {log.outputTokens.toLocaleString()} tokens</span><strong>-{log.credits} 积分</strong></div></div>)}</div>}
      <div className="modal-actions">{creditsManaged ? <a className="secondary-button" style={{ textDecoration: 'none' }} href="https://account.ljhsu.xin/credits" target="_blank" rel="noreferrer">账号中心</a> : null}<button className="secondary-button" onClick={() => { setCreditsOpen(false); setSettingsTab('model'); setSettingsOpen(true) }}>充值</button><button className="primary-button" onClick={() => setCreditsOpen(false)}>完成</button></div>
    </div></div>}
    {migration && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) skipAnonymousHistory() }}><div className="settings-modal migration-modal" role="dialog" aria-modal="true" aria-label="导入本机练习">
      <div className="modal-head"><div><h2>导入本机练习？</h2></div></div>
      <p className="settings-intro">这台浏览器里有 {migration.length} 条未登录时保存的练习。导入后只属于当前账号，并从匿名历史中移除；以后换账号或退出登录都不会再看到。</p>
      <div className="modal-actions"><button className="secondary-button" onClick={skipAnonymousHistory}>暂不导入</button><button className="primary-button" onClick={importAnonymousHistory}>导入到当前账号</button></div>
    </div></div>}
  </div>
}
