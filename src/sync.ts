import { newestFirst, sanitizeSession } from './sessionUtils'
import type { Session } from './types'

type Meta = { lastSync: number; sessions: Record<string, { updatedAt: number; hash: string }> }
type RemoteSession = { sessionId: string; updatedAt: number; payload: string }
type Prepared = { sessionId: string; updatedAt: number; payload: string; hash: string; session: Session }

const metaKey = (sub: string) => `echomind-sync-v1:${sub}`

function readMeta(sub: string): Meta {
  try {
    const value = JSON.parse(localStorage.getItem(metaKey(sub)) || 'null') as Meta | null
    if (value && typeof value.lastSync === 'number' && value.sessions && typeof value.sessions === 'object') return value
  } catch { /* 损坏时从空元数据开始，重新同步。 */ }
  return { lastSync: 0, sessions: {} }
}

function saveMeta(sub: string, meta: Meta) {
  try { localStorage.setItem(metaKey(sub), JSON.stringify(meta)) } catch { /* 元数据写入失败只影响增量效率。 */ }
}

function hash(value: string): string {
  let result = 2166136261
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}

export type SyncResult = { sessions: Session[] | null; changed: boolean; error?: string }

/**
 * 推送本地变更并拉取服务端更新。
 * 冲突按每个练习的 updatedAt 最后写入优先；同步内容包含原始转写，不含音频。
 */
export async function syncHistory(sub: string, local: Session[]): Promise<SyncResult> {
  const meta = readMeta(sub)
  const now = Date.now()
  const prepared: Prepared[] = []
  for (const session of local) {
    if (!session.createdAt) continue
    const payload = JSON.stringify(session)
    // 单条超过 1.5MB 的练习不上传，避免整个同步失败。
    if (payload.length > 1_500_000) continue
    const digest = hash(payload)
    const previous = meta.sessions[session.createdAt]
    prepared.push({
      sessionId: session.createdAt,
      updatedAt: previous && previous.hash === digest ? previous.updatedAt : now,
      payload,
      hash: digest,
      session,
    })
  }

  let response: Response
  try {
    response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        since: meta.lastSync,
        sessions: prepared.map(item => ({ sessionId: item.sessionId, updatedAt: item.updatedAt, payload: item.payload })),
      }),
    })
  } catch {
    return { sessions: null, changed: false, error: '无法连接同步服务' }
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    return { sessions: null, changed: false, error: data.error || '同步失败' }
  }
  const data = await response.json() as { serverTime?: number; sessions?: RemoteSession[] }
  if (!Array.isArray(data.sessions)) return { sessions: null, changed: false, error: '同步响应异常' }

  const merged = new Map<string, { session: Session; updatedAt: number; hash: string }>()
  for (const item of prepared) merged.set(item.sessionId, { session: item.session, updatedAt: item.updatedAt, hash: item.hash })

  let changed = false
  for (const remote of data.sessions) {
    let parsed: Session | null = null
    try { parsed = sanitizeSession(JSON.parse(remote.payload)) } catch { parsed = null }
    if (!parsed) continue
    const current = merged.get(remote.sessionId)
    const knownUpdatedAt = current?.updatedAt ?? meta.sessions[remote.sessionId]?.updatedAt ?? 0
    if (!current || remote.updatedAt > knownUpdatedAt) {
      merged.set(remote.sessionId, { session: parsed, updatedAt: remote.updatedAt, hash: hash(remote.payload) })
      changed = true
    }
  }

  const nextMeta: Meta = { lastSync: typeof data.serverTime === 'number' ? data.serverTime : now, sessions: {} }
  for (const [id, item] of merged) nextMeta.sessions[id] = { updatedAt: item.updatedAt, hash: item.hash }
  saveMeta(sub, nextMeta)

  return { sessions: newestFirst([...merged.values()].map(item => item.session)), changed }
}
