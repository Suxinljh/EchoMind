import { newestFirst, sanitizeSession } from './sessionUtils'
import type { Session } from './types'

type Meta = { lastSync: number; lastSyncId?: string; cursorVersion?: number; clockOffset?: number; sessions: Record<string, { updatedAt: number; hash: string }> }
type RemoteSession = { sessionId: string; updatedAt: number; payload: string }
type Prepared = { sessionId: string; updatedAt: number; payload: string; hash: string; bytes: number; session: Session }

const metaKey = (sub: string) => `echomind-sync-v1:${sub}`
// 旧版本把响应里的 serverTime 当游标，可能因读副本延迟永久漏拉；升级后做一次全量回补。
const CURSOR_VERSION = 2
// 单次同步最多翻 20 页（1 万条）；未拉完时游标停在本页最后一条，下次同步继续。
const MAX_PAGES = 20

function readMeta(sub: string): Meta {
  try {
    const value = JSON.parse(localStorage.getItem(metaKey(sub)) || 'null') as Meta | null
    if (value && typeof value.lastSync === 'number' && value.sessions && typeof value.sessions === 'object') {
      return {
        lastSync: value.lastSync,
        lastSyncId: typeof value.lastSyncId === 'string' ? value.lastSyncId : '',
        cursorVersion: typeof value.cursorVersion === 'number' ? value.cursorVersion : 0,
        clockOffset: typeof value.clockOffset === 'number' ? value.clockOffset : 0,
        sessions: value.sessions,
      }
    }
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

export type SyncCursor = { since: number; sinceId: string; version: number }
export type SyncResult = { sessions: Session[] | null; changed: boolean; error?: string; skipped?: number; previousCursor?: SyncCursor }

type SyncResponse = { serverTime?: number; sessions?: RemoteSession[]; nextSince?: number; nextSinceId?: string; hasMore?: boolean }
type SyncRequest = {
  since: number
  sinceId: string
  sessions: { sessionId: string; updatedAt: number; payload: string }[]
  pull?: false
}
// 服务端单次最多 200 条/8MB；客户端按条数和 UTF-8 字节数分批，留出余量。
const PUSH_BATCH_SIZE = 200
const PUSH_BATCH_BYTES = 7_000_000
// D1 单行上限 2,000,000 字节；超过这个值的练习只保留本地，不推送。
const MAX_SESSION_BYTES = 1_900_000

async function postSync(body: SyncRequest): Promise<{ data: SyncResponse } | { error: string }> {
  let response: Response
  try {
    response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { error: '无法连接同步服务' }
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    return { error: data.error || '同步失败' }
  }
  try {
    const data = await response.json() as SyncResponse
    if (!Array.isArray(data.sessions)) return { error: '同步响应异常' }
    return { data }
  } catch {
    return { error: '同步响应异常' }
  }
}

function pushBatches(items: Prepared[]): Prepared[][] {
  const batches: Prepared[][] = []
  let current: Prepared[] = []
  let bytes = 0
  for (const item of items) {
    if (current.length >= PUSH_BATCH_SIZE || (current.length > 0 && bytes + item.bytes > PUSH_BATCH_BYTES)) {
      batches.push(current); current = []; bytes = 0
    }
    current.push(item); bytes += item.bytes
  }
  if (current.length) batches.push(current)
  return batches
}

const wire = (item: Prepared) => ({ sessionId: item.sessionId, updatedAt: item.updatedAt, payload: item.payload })

/**
 * 本次同步的拉取结果被本地并发编辑丢弃时调用：把游标退回本次同步之前的位置，
 * 让下一次同步重新拉取被丢弃的远端记录。本地 hash 元数据保留，未变化的内容不会重推。
 */
export function resetSyncCursor(sub: string, cursor: SyncCursor, keepSessionIds: string[]) {
  const meta = readMeta(sub)
  const keep = new Set(keepSessionIds)
  // 只保留本地仍存在的会话 hash；远端独有的记录必须重新拉取并应用，不能只靠游标回退。
  const sessions = Object.fromEntries(Object.entries(meta.sessions).filter(([id]) => keep.has(id)))
  saveMeta(sub, { ...meta, lastSync: cursor.since, lastSyncId: cursor.sinceId, cursorVersion: cursor.version, sessions })
}

/**
 * 推送本地变更并拉取服务端更新。
 * 冲突按服务端接收时间最后写入优先；同步内容包含原始转写，不含音频。
 */
export async function syncHistory(sub: string, local: Session[]): Promise<SyncResult> {
  const meta = readMeta(sub)
  const clockOffset = meta.clockOffset || 0
  // 用服务端时间偏移校正本地时间，减少设备时钟偏差对冲突比较的影响。
  const now = Date.now() + clockOffset
  const prepared: Prepared[] = []
  const changedItems: Prepared[] = []
  const merged = new Map<string, { session: Session; updatedAt: number; hash: string }>()
  let skipped = 0
  for (const session of local) {
    if (!session.createdAt) continue
    const payload = JSON.stringify(session)
    const digest = hash(payload)
    const bytes = new TextEncoder().encode(payload).byteLength
    if (bytes > MAX_SESSION_BYTES) {
      // 超过 D1 单行上限：只保留在本地合并结果里，避免应用远端结果时丢掉这条练习。
      skipped += 1
      merged.set(session.createdAt, {
        session,
        updatedAt: meta.sessions[session.createdAt]?.updatedAt ?? now,
        hash: digest,
      })
      continue
    }
    const previous = meta.sessions[session.createdAt]
    const unchanged = !!previous && previous.hash === digest
    const item: Prepared = {
      sessionId: session.createdAt,
      updatedAt: unchanged && previous ? previous.updatedAt : now,
      payload,
      hash: digest,
      bytes,
      session,
    }
    prepared.push(item)
    // 只推送内容变化的练习；未变化的本地副本仍参与合并结果。
    if (!unchanged) changedItems.push(item)
  }
  for (const item of prepared) merged.set(item.sessionId, { session: item.session, updatedAt: item.updatedAt, hash: item.hash })

  // 先按 ≤200 条/≤7MB 分批推送；非最后一批不拉取，避免重复返回第一页。
  const batches = pushBatches(changedItems)
  const firstPullBatch = batches.length ? batches[batches.length - 1] : []
  for (let index = 0; index < batches.length - 1; index += 1) {
    const sent = await postSync({ since: 0, sinceId: '', sessions: batches[index].map(wire), pull: false })
    if ('error' in sent) return { sessions: null, changed: false, error: sent.error }
  }

  // 旧游标可能已经越过未复制的写入；升级后从 0 做一次全量回补，再按行游标增量同步。
  const hasCursor = meta.cursorVersion === CURSOR_VERSION
  let cursorAt = hasCursor ? meta.lastSync : 0
  let cursorId = hasCursor ? meta.lastSyncId || '' : ''
  // 供调用方在丢弃本次结果时回退，避免已推进的游标越过未应用的远端记录。
  const previousCursor: SyncCursor = { since: cursorAt, sinceId: cursorId, version: hasCursor ? CURSOR_VERSION : 0 }
  let serverTime: number | null = null
  let changed = false

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sent = await postSync({
      since: cursorAt,
      sinceId: cursorId,
      // 只在第一页推送最后一批本地变更，后续页只拉取。
      sessions: page === 0 ? firstPullBatch.map(wire) : [],
    })
    if ('error' in sent) return { sessions: null, changed: false, error: sent.error }
    const data = sent.data
    if (typeof data.serverTime === 'number') serverTime = data.serverTime

    for (const remote of data.sessions ?? []) {
      let parsed: Session | null = null
      try { parsed = sanitizeSession(JSON.parse(remote.payload)) } catch { parsed = null }
      if (!parsed) continue
      const remoteHash = hash(remote.payload)
      const current = merged.get(remote.sessionId)
      if (!current) {
        merged.set(remote.sessionId, { session: parsed, updatedAt: remote.updatedAt, hash: remoteHash })
        changed = true
        continue
      }
      // 内容相同：以服务端时间归一化，避免客户端时钟偏差影响后续比较。
      if (current.hash === remoteHash) {
        current.updatedAt = remote.updatedAt
        continue
      }
      if (remote.updatedAt > current.updatedAt) {
        merged.set(remote.sessionId, { session: parsed, updatedAt: remote.updatedAt, hash: remoteHash })
        changed = true
      }
    }

    if (typeof data.nextSince !== 'number') {
      // 兼容尚未返回行游标的旧服务端，退回原来的 serverTime 行为。
      cursorAt = serverTime ?? Date.now()
      cursorId = ''
      break
    }
    cursorAt = data.nextSince
    cursorId = typeof data.nextSinceId === 'string' ? data.nextSinceId : ''
    if (!data.hasMore) break
  }

  const nextMeta: Meta = {
    lastSync: cursorAt,
    lastSyncId: cursorId,
    cursorVersion: CURSOR_VERSION,
    clockOffset: serverTime === null ? clockOffset : serverTime - Date.now(),
    sessions: {},
  }
  for (const [id, item] of merged) nextMeta.sessions[id] = { updatedAt: item.updatedAt, hash: item.hash }
  saveMeta(sub, nextMeta)

  return { sessions: newestFirst([...merged.values()].map(item => item.session)), changed, skipped, previousCursor }
}
