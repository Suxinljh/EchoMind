/**
 * 平台模型网关与积分计量。
 *
 * 计费按 token：供应商成本 × `PLATFORM_MARKUP`（当前生产 5 倍），1 积分 = ¥0.01。
 * 设置 CREDITS_APP_KEY 后余额与扣费走账号中心；否则退回自有 wallet（本地/回滚）。
 * 所有平台调用都在服务端记录真实 usage，客户端只负责展示余额和日志。
 */

import { readAccount } from './auth'
import { accountCreditsEnabled, consumeAccountCredits, readAccountBalance, type CreditsEnv } from './accountCredits'
import { allowRequest } from './rateLimit'

export type PlatformEnv = Env & {
  DB: D1Database
  PLATFORM_API_KEY?: string
  PLATFORM_MODEL_BASE_URL?: string
  PLATFORM_MODEL_ID?: string
  PLATFORM_INPUT_COST_PER_M?: string
  PLATFORM_OUTPUT_COST_PER_M?: string
  PLATFORM_MARKUP?: string
} & CreditsEnv

export type UsageKind = 'plan' | 'evaluate' | 'overall' | 'test'

const CREDIT_CNY = 0.01
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_INPUT_COST = 2
const DEFAULT_OUTPUT_COST = 8
// 客户端最多等 95 秒；服务端提前超时并中止上游，避免客户端放弃后仍继续生成/计费。
const PLATFORM_TIMEOUT_MS = 60_000

/** 每类调用的输出上限，防止异常输出放大成本。 */
const MAX_TOKENS: Record<UsageKind, number> = {
  plan: 1200,
  evaluate: 1400,
  overall: 900,
  test: 16,
}

const KINDS = new Set<UsageKind>(['plan', 'evaluate', 'overall', 'test'])
// 平台模型响应缓存 1 小时；客户端自动重试同一 requestId 时直接返回缓存，不重复扣费。
const REQUEST_CACHE_TTL_MS = 60 * 60_000
// 过期缓存清理放在每次调用的 batch 里，单次最多删这么多行，避免请求延迟随表体积增长。
const REQUEST_CACHE_SWEEP_LIMIT = 200

/**
 * 平台模型按账号限流：Cloudflare Rate Limiting 绑定在本账号的生产环境实测不生效，
 * 所以用 D1 固定窗口计数器作为真正生效的限额（每账号 20 次/60 秒）。
 */
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60_000

function sweepExpiredRequests(env: PlatformEnv, now: number): D1PreparedStatement {
  return env.DB.prepare(
    'delete from platform_request where rowid in (select rowid from platform_request where created_at < ? limit ?)',
  ).bind(now - REQUEST_CACHE_TTL_MS, REQUEST_CACHE_SWEEP_LIMIT)
}

type CachedRequest = { response_text: string; input_tokens: number; output_tokens: number; credits: number }

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function platformConfigured(env: PlatformEnv): boolean {
  return Boolean(env.PLATFORM_API_KEY)
}

async function getBalance(env: PlatformEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare('select balance from wallet where user_id = ?').bind(userId).first<{ balance: number }>()
  return row?.balance ?? 0
}

export async function handlePlatformModel(request: Request, env: PlatformEnv): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
  const account = await readAccount(request, env)
  if (!account) return json(401, { error: '请先登录' })
  if (!env.PLATFORM_API_KEY) return json(503, { error: '平台模型尚未配置' })
  const now = Date.now()
  if (!(await allowRequest(env, 'platform', account.sub, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, now))) {
    return json(429, { error: '请求过于频繁，请稍后再试' }, { 'Retry-After': '60' })
  }

  const body = await request.json().catch(() => null) as { kind?: string; messages?: unknown; requestId?: unknown } | null
  if (!body || typeof body.kind !== 'string' || !KINDS.has(body.kind as UsageKind)) return json(400, { error: '未知的调用类型' })
  const kind = body.kind as UsageKind
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 40) return json(400, { error: '请求内容不完整' })
  const requestId = typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 100 ? body.requestId : ''

  let totalChars = 0
  const messages: { role: string; content: string }[] = []
  for (const item of body.messages) {
    if (!item || typeof item !== 'object') return json(400, { error: '请求内容不完整' })
    const message = item as { role?: unknown; content?: unknown }
    if (!['system', 'user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string') return json(400, { error: '请求内容不完整' })
    totalChars += message.content.length
    if (totalChars > 80_000) return json(413, { error: '请求内容过大' })
    messages.push({ role: String(message.role), content: message.content })
  }

  // 已完成的同一请求直接返回缓存，不重复调用上游、不重复扣费。
  if (requestId) {
    const cached = await env.DB.prepare('select response_text, input_tokens, output_tokens, credits from platform_request where user_id = ? and request_id = ?')
      .bind(account.sub, requestId)
      .first<CachedRequest>()
    if (cached) {
      const cachedBalance = accountCreditsEnabled(env) ? await readAccountBalance(env, account.sub) : await getBalance(env, account.sub)
      return json(200, {
        text: cached.response_text,
        usage: { input: cached.input_tokens, output: cached.output_tokens },
        credits: cached.credits,
        ...(cachedBalance === null ? {} : { balance: cachedBalance }),
        cached: true,
      })
    }
  }

  const balance = accountCreditsEnabled(env) ? await readAccountBalance(env, account.sub) : await getBalance(env, account.sub)
  if (balance === null) return json(503, { error: '无法读取账号积分，请稍后重试' })
  if (balance < 1) return json(402, { error: '积分不足，请先充值' })

  const baseUrl = (env.PLATFORM_MODEL_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  const model = env.PLATFORM_MODEL_ID || DEFAULT_MODEL
  const maxTokens = MAX_TOKENS[kind]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS)
  const abortFromClient = () => controller.abort()
  request.signal.addEventListener('abort', abortFromClient)
  let raw = ''
  let responseOk = false
  let status = 0
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PLATFORM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
      signal: controller.signal,
    })
    responseOk = response.ok
    status = response.status
    raw = await response.text()
  } catch {
    return json(504, { error: controller.signal.aborted ? '平台模型响应超时或连接已中断，请稍后重试' : '平台模型网络异常，请稍后重试' })
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abortFromClient)
  }

  if (!responseOk) return json(502, { error: `平台模型调用失败（HTTP ${status}）` })
  let result: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  try {
    result = JSON.parse(raw)
  } catch {
    return json(502, { error: '平台模型返回格式异常' })
  }
  const text = result.choices?.[0]?.message?.content
  if (!text || !text.trim()) return json(502, { error: '平台模型没有返回文本内容' })

  // 供应商没有返回 usage 时按字符粗略估算，保证不会漏计费。
  const inputTokens = result.usage?.prompt_tokens ?? Math.ceil(totalChars / 2)
  const outputTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 2)
  const inputCost = (inputTokens / 1_000_000) * numberEnv(env.PLATFORM_INPUT_COST_PER_M, DEFAULT_INPUT_COST)
  const outputCost = (outputTokens / 1_000_000) * numberEnv(env.PLATFORM_OUTPUT_COST_PER_M, DEFAULT_OUTPUT_COST)
  const costCny = inputCost + outputCost
  const markup = numberEnv(env.PLATFORM_MARKUP, 2)
  const credits = Math.max(1, Math.ceil((costCny * markup) / CREDIT_CNY))

  // 客户端已断开时不再扣费。
  if (request.signal.aborted) return json(499, { error: '请求已取消' })

  const usageId = crypto.randomUUID()

  if (accountCreditsEnabled(env)) {
    // 账号中心扣费：先确认扣款成功，再返回模型结果；requestId 缺失时用一次性 ID。
    const chargeId = requestId || crypto.randomUUID()
    const charged = await consumeAccountCredits(env, account.sub, chargeId, credits)
    if (!charged.ok) return json(charged.status, { error: charged.error })
    // 同一 requestId 已扣过费（并发或重试）：返回缓存，不再写第二条本地用量。
    if (charged.duplicate && requestId) {
      const existing = await env.DB.prepare('select response_text, input_tokens, output_tokens, credits from platform_request where user_id = ? and request_id = ?')
        .bind(account.sub, requestId)
        .first<CachedRequest>()
      if (existing) return json(200, {
        text: existing.response_text,
        usage: { input: existing.input_tokens, output: existing.output_tokens },
        credits: existing.credits,
        balance: charged.balance,
        cached: true,
      })
      return json(200, {
        text,
        usage: { input: inputTokens, output: outputTokens },
        credits,
        balance: charged.balance,
      })
    }
    // 扣费成功后再写响应缓存：缓存写失败只会让重试再调一次上游，consume 幂等不会重复扣费。
    try {
      const statements: D1PreparedStatement[] = []
      if (requestId) {
        statements.push(
          env.DB.prepare(`insert into platform_request (user_id, request_id, kind, model, response_text, input_tokens, output_tokens, credits, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(user_id, request_id) do nothing`)
            .bind(account.sub, requestId, kind, model, text, inputTokens, outputTokens, credits, now),
        )
      }
      // 本地只保留 token/模型明细，供积分弹窗展示；余额和台账以账号中心为准。
      statements.push(
        env.DB.prepare(`insert into model_usage (id, user_id, kind, model, input_tokens, output_tokens, cost_cny, credits, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(usageId, account.sub, kind, model, inputTokens, outputTokens, costCny, credits, now),
        sweepExpiredRequests(env, now),
      )
      await env.DB.batch(statements)
    } catch (error) {
      console.error('[platform] 写入用量明细失败', error)
    }
    return json(200, {
      text,
      usage: { input: inputTokens, output: outputTokens },
      credits,
      balance: charged.balance,
    })
  }

  if (requestId) {
    // 缓存插入 + 条件扣余额 + 台账 + 用量 + 过期清理在同一个 batch（事务）内。
    // 缓存插入冲突说明同一请求已完成；钱包更新用 changes() 门控，避免重复扣费。
    const results = await env.DB.batch([
      env.DB.prepare(`insert into platform_request (user_id, request_id, kind, model, response_text, input_tokens, output_tokens, credits, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(user_id, request_id) do nothing`)
        .bind(account.sub, requestId, kind, model, text, inputTokens, outputTokens, credits, now),
      env.DB.prepare('update wallet set balance = balance - ?, updated_at = ? where user_id = ? and balance >= ? and changes() = 1')
        .bind(credits, now, account.sub, credits),
      env.DB.prepare(`insert into credit_ledger (id, user_id, delta, reason, ref, created_at)
        select ?, ?, ?, 'model_usage', ?, ? where changes() = 1`)
        .bind(usageId, account.sub, -credits, usageId, now),
      env.DB.prepare(`insert into model_usage (id, user_id, kind, model, input_tokens, output_tokens, cost_cny, credits, created_at)
        select ?, ?, ?, ?, ?, ?, ?, ?, ? where changes() = 1`)
        .bind(usageId, account.sub, kind, model, inputTokens, outputTokens, costCny, credits, now),
      sweepExpiredRequests(env, now),
    ])
    const cachedInserted = results[0]?.meta.changes === 1
    const charged = results[1]?.meta.changes === 1
    if (!cachedInserted) {
      const existing = await env.DB.prepare('select response_text, input_tokens, output_tokens, credits from platform_request where user_id = ? and request_id = ?')
        .bind(account.sub, requestId)
        .first<CachedRequest>()
      if (existing) return json(200, {
        text: existing.response_text,
        usage: { input: existing.input_tokens, output: existing.output_tokens },
        credits: existing.credits,
        balance: await getBalance(env, account.sub),
        cached: true,
      })
      return json(409, { error: '请求已处理，请稍后重试' })
    }
    if (!charged) {
      // 余额不足：本次插入的缓存没有扣费，删除以免后续重试白拿结果。
      await env.DB.prepare('delete from platform_request where user_id = ? and request_id = ?').bind(account.sub, requestId).run()
      return json(402, { error: '积分不足，请先充值' })
    }
  } else {
    // 旧客户端不带 requestId：保持原有扣费路径。
    const results = await env.DB.batch([
      env.DB.prepare('update wallet set balance = balance - ?, updated_at = ? where user_id = ? and balance >= ?')
        .bind(credits, now, account.sub, credits),
      env.DB.prepare(`insert into credit_ledger (id, user_id, delta, reason, ref, created_at)
        select ?, ?, ?, 'model_usage', ?, ? where changes() = 1`)
        .bind(usageId, account.sub, -credits, usageId, now),
      env.DB.prepare(`insert into model_usage (id, user_id, kind, model, input_tokens, output_tokens, cost_cny, credits, created_at)
        select ?, ?, ?, ?, ?, ?, ?, ?, ? where changes() = 1`)
        .bind(usageId, account.sub, kind, model, inputTokens, outputTokens, costCny, credits, now),
    ])
    if (results[0]?.meta.changes !== 1) return json(402, { error: '积分不足，请先充值' })
  }

  return json(200, {
    text,
    usage: { input: inputTokens, output: outputTokens },
    credits,
    balance: await getBalance(env, account.sub),
  })
}

export async function handleCredits(request: Request, env: PlatformEnv): Promise<Response> {
  const url = new URL(request.url)
  const account = await readAccount(request, env)
  if (!account) return json(401, { error: '请先登录' })
  const managed = accountCreditsEnabled(env)
  const balance = managed ? await readAccountBalance(env, account.sub) : await getBalance(env, account.sub)
  if (balance === null) return json(503, { error: '无法读取账号积分，请稍后重试' })
  if (url.pathname === '/api/credits') {
    return json(200, { balance, configured: platformConfigured(env), managed })
  }
  const rows = await env.DB.prepare('select id, kind, model, input_tokens, output_tokens, credits, created_at from model_usage where user_id = ? order by created_at desc limit 20')
    .bind(account.sub)
    .all<{ id: string; kind: string; model: string; input_tokens: number; output_tokens: number; credits: number; created_at: number }>()
  return json(200, {
    balance,
    managed,
    logs: (rows.results ?? []).map(row => ({
      id: row.id,
      kind: row.kind,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      credits: row.credits,
      createdAt: row.created_at,
    })),
  })
}
