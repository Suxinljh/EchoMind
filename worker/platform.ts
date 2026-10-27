/**
 * 平台模型网关与积分计量。
 *
 * 计费按 token：供应商成本 × 2，1 积分 = ¥0.01。
 * 所有平台调用都在服务端记录真实 usage，客户端只负责展示余额和日志。
 */

import { readAccount } from './auth'

export type PlatformEnv = Env & {
  DB: D1Database
  PLATFORM_API_KEY?: string
  PLATFORM_MODEL_BASE_URL?: string
  PLATFORM_MODEL_ID?: string
  PLATFORM_INPUT_COST_PER_M?: string
  PLATFORM_OUTPUT_COST_PER_M?: string
}

export type UsageKind = 'plan' | 'evaluate' | 'overall' | 'test'

const CREDIT_CNY = 0.01
const MARKUP = 2
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_INPUT_COST = 2
const DEFAULT_OUTPUT_COST = 8

/** 每类调用的输出上限，防止异常输出放大成本。 */
const MAX_TOKENS: Record<UsageKind, number> = {
  plan: 1200,
  evaluate: 1400,
  overall: 900,
  test: 16,
}

const KINDS = new Set<UsageKind>(['plan', 'evaluate', 'overall', 'test'])

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
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

  const body = await request.json().catch(() => null) as { kind?: string; messages?: unknown } | null
  if (!body || typeof body.kind !== 'string' || !KINDS.has(body.kind as UsageKind)) return json(400, { error: '未知的调用类型' })
  const kind = body.kind as UsageKind
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 40) return json(400, { error: '请求内容不完整' })

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

  const balance = await getBalance(env, account.sub)
  if (balance < 1) return json(402, { error: '积分不足，请先充值' })

  const baseUrl = (env.PLATFORM_MODEL_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  const model = env.PLATFORM_MODEL_ID || DEFAULT_MODEL
  const maxTokens = MAX_TOKENS[kind]

  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PLATFORM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens }),
    })
  } catch {
    return json(502, { error: '平台模型网络异常，请稍后重试' })
  }

  const raw = await response.text()
  if (!response.ok) return json(502, { error: `平台模型调用失败（HTTP ${response.status}）` })
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
  const credits = Math.max(1, Math.ceil((costCny * MARKUP) / CREDIT_CNY))

  const usageId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('update wallet set balance = balance - ?, updated_at = ? where user_id = ?').bind(credits, now, account.sub),
    env.DB.prepare('insert into credit_ledger (id, user_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)')
      .bind(usageId, account.sub, -credits, 'model_usage', usageId, now),
    env.DB.prepare('insert into model_usage (id, user_id, kind, model, input_tokens, output_tokens, cost_cny, credits, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(usageId, account.sub, kind, model, inputTokens, outputTokens, costCny, credits, now),
  ])

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
  const balance = await getBalance(env, account.sub)
  if (url.pathname === '/api/credits') {
    return json(200, { balance, configured: platformConfigured(env) })
  }
  const rows = await env.DB.prepare('select id, kind, model, input_tokens, output_tokens, credits, created_at from model_usage where user_id = ? order by created_at desc limit 20')
    .bind(account.sub)
    .all<{ id: string; kind: string; model: string; input_tokens: number; output_tokens: number; credits: number; created_at: number }>()
  return json(200, {
    balance,
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
