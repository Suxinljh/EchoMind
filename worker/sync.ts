/**
 * 练习历史跨设备同步。
 *
 * 以 session_id（练习的 createdAt）为键，按 updated_at 做最后写入优先。
 * 同步内容包含原始转写、语义稿、评分和报告，但不包含音频。
 */

import { readAccount } from './auth'

export type SyncEnv = Env & { DB: D1Database }

const MAX_SESSIONS = 200
// D1 单行上限 2,000,000 字节；留出 user_id/session_id/updated_at 等列的余量。
const MAX_SESSION_BYTES = 1_900_000
const MAX_TOTAL_BYTES = 8_000_000
// 单次拉取上限。客户端按返回的 (updated_at, session_id) 游标继续翻页。
const PAGE_SIZE = 500

type IncomingSession = { sessionId: string; updatedAt: number; payload: string }

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function handleSync(request: Request, env: SyncEnv): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
  const account = await readAccount(request, env)
  if (!account) return json(401, { error: '请先登录' })

  const body = await request.json().catch(() => null) as { since?: unknown; sinceId?: unknown; sessions?: unknown; pull?: unknown } | null
  if (!body) return json(400, { error: '请求体必须是 JSON' })
  const since = typeof body.since === 'number' && Number.isFinite(body.since) ? Math.max(0, body.since) : 0
  const sinceId = typeof body.sinceId === 'string' ? body.sinceId.slice(0, 120) : ''
  const incoming: IncomingSession[] = []
  let totalBytes = 0

  if (body.sessions !== undefined) {
    if (!Array.isArray(body.sessions) || body.sessions.length > MAX_SESSIONS) return json(400, { error: '练习数量超出限制' })
    for (const item of body.sessions) {
      if (!item || typeof item !== 'object') return json(400, { error: '同步数据格式错误' })
      const session = item as { sessionId?: unknown; updatedAt?: unknown; payload?: unknown }
      if (typeof session.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 120) return json(400, { error: '练习标识无效' })
      if (typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)) return json(400, { error: '更新时间无效' })
      if (typeof session.payload !== 'string' || !session.payload) return json(400, { error: '练习内容缺失' })
      const payloadBytes = new TextEncoder().encode(session.payload).byteLength
      if (payloadBytes > MAX_SESSION_BYTES) return json(413, { error: '单条练习过大，未同步' })
      totalBytes += payloadBytes
      if (totalBytes > MAX_TOTAL_BYTES) return json(413, { error: '同步内容过大' })
      incoming.push({ sessionId: session.sessionId, updatedAt: session.updatedAt, payload: session.payload })
    }
  }

  const now = Date.now()
  if (incoming.length) {
    // 以服务端接收时间为准，避免客户端时钟偏差影响其他设备的游标和冲突比较；
    // 客户端只推送内容变化的练习，payload 相同的重复推送不会更新时间。
    const statements = incoming.map(session => env.DB.prepare(
      `insert into practice_sessions (user_id, session_id, payload, updated_at) values (?, ?, ?, ?)
       on conflict(user_id, session_id) do update set payload = excluded.payload, updated_at = excluded.updated_at
       where practice_sessions.payload <> excluded.payload`,
    ).bind(account.sub, session.sessionId, session.payload, now))
    for (let index = 0; index < statements.length; index += 20) {
      await env.DB.batch(statements.slice(index, index + 20))
    }
  }

  // 分批推送时，非最后一批只需要写入，不需要顺带拉取。
  if (body.pull === false) return json(200, { serverTime: now, sessions: [], nextSince: since, nextSinceId: sinceId, hasMore: false })

  // 游标使用 (updated_at, session_id)，避免同一毫秒内的记录在分页边界被跳过。
  // 不使用响应时的 serverTime 作为游标：读副本延迟或时钟偏移会让客户端永久跳过已写入的行。
  const rows = await env.DB.prepare(
    `select session_id, payload, updated_at from practice_sessions
     where user_id = ? and (updated_at > ? or (updated_at = ? and session_id > ?))
     order by updated_at asc, session_id asc limit ${PAGE_SIZE}`,
  ).bind(account.sub, since, since, sinceId).all<{ session_id: string; payload: string; updated_at: number }>()
  const results = rows.results ?? []
  const last = results[results.length - 1]
  // 客户端时间可能超前（写入时最多允许 now + 5 分钟）；游标最多推进到服务端当前时间，
  // 避免一次超前写入把后续正常时间的记录整段跳过。
  const nextSince = last ? Math.min(last.updated_at, now) : since
  // 空页时保持请求游标不变，避免下次同步重复拉取同一毫秒内的记录。
  const nextSinceId = last ? (last.updated_at <= now ? last.session_id : '') : sinceId

  return json(200, {
    serverTime: now,
    sessions: results.map(row => ({ sessionId: row.session_id, updatedAt: row.updated_at, payload: row.payload })),
    nextSince,
    nextSinceId,
    hasMore: results.length === PAGE_SIZE,
  })
}
