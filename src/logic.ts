import type { Answer, Dimension, Evaluation, InterviewSettings, Mode, ReportSettings, Session, Task } from './types'

export const interviewRubric = [
  { name: '切题与岗位匹配', weight: 0.3 }, { name: '具体事实与证据', weight: 0.3 },
  { name: '结构与表达', weight: 0.25 }, { name: '反思与下一步', weight: 0.15 },
]
export const introRubric = [
  { name: '定位与岗位关联', weight: 0.35 }, { name: '经历与成果证据', weight: 0.3 },
  { name: '表达结构', weight: 0.2 }, { name: '动机与收束', weight: 0.15 },
]
export const candidateRubric = [
  { name: '问题与岗位关联', weight: 0.35 }, { name: '洞察与信息价值', weight: 0.3 },
  { name: '提问清晰度', weight: 0.2 }, { name: '沟通分寸', weight: 0.15 },
]
export const reportRubric = [
  { name: '目标与结论清晰', weight: 0.3 }, { name: '关键事实与进展', weight: 0.3 },
  { name: '问题、风险与应对', weight: 0.2 }, { name: '面向听众的行动请求', weight: 0.2 },
]
export const audienceCriteria = ['结论先行', '背景适量', '证据具体', '术语适配']
export function rubricFor(task: Task) { return task.kind === 'report' ? reportRubric : task.kind === 'intro' ? introRubric : task.kind === 'candidate' ? candidateRubric : interviewRubric }

export function offlineTasks(mode: Mode, settings: InterviewSettings | ReportSettings): Task[] {
  if (mode === 'report') {
    const s = settings as ReportSettings
    return [{ id: 'report-1', title: '连续汇报', prompt: `请向${s.audience}汇报「${s.topic}」。先说结论，再说明进展、风险和需要的行动。`, kind: 'report' }]
  }
  const s = settings as InterviewSettings
  const tasks: Task[] = []
  if (s.includeIntro) tasks.push({ id: 'intro', title: '自我介绍', prompt: `请用 1–2 分钟介绍自己，并说明为什么适合${s.position}。`, kind: 'intro' })
  const prompts = [
    `请介绍一段与${s.position}最相关的项目经历。你承担什么职责，结果如何？`,
    `遇到过最复杂的问题是什么？你如何判断优先级并推进解决？`,
    `请举一个需要跨团队协作的例子。分歧出现时你怎样处理？`,
    `你怎样衡量自己工作的效果？请给出一个具体指标和结果。`,
    `回顾一次没有达到目标的经历。你学到了什么，后来如何改进？`,
    `面对不明确的需求，你会如何澄清目标并验证假设？请讲一个实际例子。`,
    `在时间或资源受限时，你如何决定哪些工作先做、哪些暂缓？`,
    `请讲述一次你根据用户或客户反馈改变方案的经历。`,
    `你如何与不同背景的利益相关方解释一个复杂方案？`,
    `请举例说明你如何处理数据与直觉相冲突的情况。`,
    `当项目出现风险时，你如何尽早发现并向相关人沟通？`,
    `你曾主动推动过什么改进？从发现问题到落地经历了什么？`,
    `你如何评价一次方案或项目是否真正成功？`,
    `请描述你收到过的一条难接受的反馈，以及后来的行动。`,
    `加入新团队的前 90 天，你会如何理解业务并建立协作？`,
  ]
  for (let i = 0; i < s.questionCount; i++) tasks.push({ id: `q-${i + 1}`, title: `专业问题 ${i + 1}`, prompt: prompts[i], kind: 'professional' })
  if (s.includeCandidate) tasks.push({ id: 'candidate', title: '反问面试官', prompt: `现在请向面试官提出你对${s.position}岗位最想了解的问题。`, kind: 'candidate' })
  return tasks
}

export function tentativeFillers(raw: string): number {
  return (raw.match(/[嗯呃额啊]/g) || []).length
}

export function speechStats(raw: string) {
  const count = (word: string) => (raw.match(new RegExp(word, 'g')) || []).length
  return { fillers: Object.fromEntries(['呃', '啊', '嗯', '额'].map(word => [word, count(word)])), transitions: Object.fromEntries(['然后', '那么'].map(word => [word, count(word)])) }
}

export function reportStats(session: Session) {
  const answered = session.answers.filter(answer => answer.status === 'answered')
  const raw = answered.map(answer => answer.raw).join('。')
  const stats = speechStats(raw)
  const repeated = new Map<string, number>()
  for (const match of raw.matchAll(/([\u4e00-\u9fff]{2,8})[，,、\s]*\1/g)) {
    const phrase = match[1]
    repeated.set(phrase, (repeated.get(phrase) || 0) + 1)
  }
  return {
    ...stats,
    repeatedPhrases: [...repeated].sort((a, b) => b[1] - a[1]).slice(0, 5),
    pauses: answered.reduce((sum, answer) => sum + answer.events.filter(event => event.kind === 'silence').length, 0),
  }
}

export function questionScore(answer?: Answer): number | null {
  if (!answer || answer.status === 'skipped') return null
  const dimensions = answer.evaluation?.dimensions
  if (!dimensions?.length || dimensions.some(d => d.score === null)) return null
  return dimensions.reduce((sum, d) => sum + d.score! * d.weight, 0)
}

export function overallScore(session: Session): { earned: number; maximum: number; complete: boolean } {
  const maximum = session.tasks.length * 5
  let earned = 0
  let complete = true
  for (const task of session.tasks) {
    const answer = session.answers.find(item => item.taskId === task.id)
    if (answer?.status === 'skipped') continue
    const score = questionScore(answer)
    if (score === null) complete = false
    else earned += score
  }
  return { earned, maximum, complete }
}

export function transcriptParagraphs(segments: string[]): string[] {
  const paragraphs: string[] = []
  for (const segment of segments) {
    const sentences = segment.trim().match(/[^。！？!?；;]+[。！？!?；;]?/g) || []
    for (const sentence of sentences) {
      let rest = sentence.trim()
      while (rest.length > 85) {
        const candidate = rest.slice(0, 85)
        const boundary = Math.max(candidate.lastIndexOf('，'), candidate.lastIndexOf(','), candidate.lastIndexOf(' '))
        const length = boundary > 35 ? boundary + 1 : 70
        paragraphs.push(rest.slice(0, length).trim())
        rest = rest.slice(length).trim()
      }
      if (rest) paragraphs.push(rest)
    }
  }
  return paragraphs
}

export function localEvaluation(task: Task, answer: Answer): Evaluation {
  const rubric = rubricFor(task)
  const dimensions: Dimension[] = rubric.map(({ name, weight }) => ({ name, weight, score: null, evidence: '未连接模型，无法依据内容可靠评分', advice: '配置模型后重新评估语义稿' }))
  return { source: 'local', summary: answer.status === 'skipped' ? '本任务已跳过' : '已保存回答；内容评估等待模型连接。', dimensions, strengths: [], nextStep: '连接模型后点击重新评估。' }
}

export function normalizeEvaluation(raw: unknown, task: Task, answer: Answer): Evaluation {
  if (!raw || typeof raw !== 'object') throw new Error('模型没有返回有效评估对象')
  const item = raw as Record<string, unknown>
  const rubric = rubricFor(task)
  const received = Array.isArray(item.dimensions) ? item.dimensions as Record<string, unknown>[] : []
  const dimensions = rubric.map(({ name, weight }, i): Dimension => {
    const d = received.find(x => x.name === name) || received[i] || {}
    const score = typeof d.score === 'number' && d.score >= 1 && d.score <= 5 ? Math.round(d.score) : null
    const evidence = typeof d.evidence === 'string' ? d.evidence : ''
    // Every numerical score must be auditable against the immutable or edited transcript.
    const supported = !!evidence && answer.semantic.includes(evidence)
    return { name, weight, score: supported ? score : null, evidence: supported ? evidence : '缺少可核对的逐字稿证据', advice: String(d.advice || '') }
  })
  const checks = Array.isArray(item.audienceChecks) ? item.audienceChecks as Record<string, unknown>[] : []
  return {
    source: 'ai', summary: String(item.summary || ''), suggestedAnswer: String(item.suggestedAnswer || ''), dimensions,
    strengths: Array.isArray(item.strengths) ? item.strengths.map(String).slice(0, 3) : [],
    nextStep: String(item.nextStep || ''),
    coverage: Array.isArray(item.coverage) ? (item.coverage as Record<string, unknown>[]).map(x => ({ item: String(x.item || ''), status: x.status === 'covered' || x.status === 'partial' ? x.status : 'missing', evidence: String(x.evidence || '') })) : [],
    audienceChecks: task.kind === 'report' ? audienceCriteria.map((criterion, i) => {
      const c = checks.find(x => x.criterion === criterion) || checks[i] || {}
      const level = typeof c.level === 'number' && c.level >= 1 && c.level <= 4 ? Math.round(c.level) : null
      const evidence = String(c.evidence || '')
      return { criterion, level: evidence && answer.semantic.includes(evidence) ? level : null, evidence: evidence && answer.semantic.includes(evidence) ? evidence : '证据不足' }
    }) : undefined,
  }
}
