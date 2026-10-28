import type { Session, Task } from './types'

export function newestFirst(items: Session[]): Session[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 历史数据可能来自更早的版本或被手动改坏；逐条校验，坏条目丢弃而不是让整页白屏。 */
export function sanitizeSession(value: unknown): Session | null {
  if (!isRecord(value)) return null
  const mode = value.mode
  if (mode !== 'interview' && mode !== 'report') return null
  if (!Array.isArray(value.tasks) || !Array.isArray(value.answers)) return null
  if (!isRecord(value.settings)) return null
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) return null
  const tasksOk = value.tasks.every(task => isRecord(task) && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.prompt === 'string')
  const answersOk = value.answers.every(answer => isRecord(answer)
    && typeof answer.taskId === 'string'
    && typeof answer.semantic === 'string'
    && Array.isArray(answer.events)
    && (answer.evaluation === undefined || (isRecord(answer.evaluation) && Array.isArray(answer.evaluation.dimensions))))
  if (!tasksOk || !answersOk) return null
  if (value.overallAnalysis !== undefined && (!isRecord(value.overallAnalysis) || !Array.isArray(value.overallAnalysis.strengths) || !Array.isArray(value.overallAnalysis.priorities))) return null
  const tasks = value.tasks as Task[]
  const raw = typeof value.current === 'number' && Number.isFinite(value.current) ? Math.floor(value.current) : 0
  return { ...(value as unknown as Session), current: Math.min(Math.max(0, raw), tasks.length) }
}
