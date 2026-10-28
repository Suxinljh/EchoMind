/**
 * 练习历史跨设备同步。
 *
 * 以 session_id（练习的 createdAt）为键，按 updated_at 做最后写入优先。
 * 同步内容包含原始转写、语义稿、评分和报告，但不包含音频。
 */

import { readAccount } from './auth'

export type SyncEnv = Env & { DB: D1Database }

const MAX_SESSIONS = 200
const MAX_SESSION_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

type IncomingSession = { sessionId: string; updatedAt: number; payload: string }

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function handleSync(request: Request, env: SyncEnv): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
  const account = await readAccount(request, env)
  if (!account) return json(401, { error: '请先登录' })

  const body = await request.json().catch(() => null) as { since?: unknown; sessions?: unknown } | null
  if (!body) return json(400, { error: '请求体必须是 JSON' })
  const since = typeof body.since === 'number' && Number.isFinite(body.since) ? Math.max(0, body.since) : 0
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
      if (session.payload.length > MAX_SESSION_BYTES) return json(413, { error: '单条练习过大，未同步' })
      totalBytes += session.payload.length
      if (totalBytes > MAX_TOTAL_BYTES) return json(413, { error: '同步内容过大' })
      incoming.push({ sessionId: session.sessionId, updatedAt: session.updatedAt, payload: session.payload })
    }
  }

  const now = Date.now()
  if (incoming.length) {
    const statements = incoming.map(session => env.DB.prepare(
      `insert into practice_sessions (user_id, session_id, payload, updated_at) values (?, ?, ?, ?)
       on conflict(user_id, session_id) do update set payload = excluded.payload, updated_at = excluded.updated_at
       where excluded.updated_at > practice_sessions.updated_at`,
    ).bind(account.sub, session.sessionId, session.payload, Math.min(session.updatedAt, now + 5 * 60_000)))
    for (let index = 0; index < statements.length; index += 20) {
      await env.DB.batch(statements.slice(index, index + 20))
    }
  }

  const rows = await env.DB.prepare(
    'select session_id, payload, updated_at from practice_sessions where user_id = ? and updated_at > ? order by updated_at asc limit 500',
  ).bind(account.sub, since).all<{ session_id: string; payload: string; updated_at: number }>()

  return json(200, {
    serverTime: now,
    sessions: (rows.results ?? []).map(row => ({ sessionId: row.session_id, updatedAt: row.updated_at, payload: row.payload })),
  })
}
