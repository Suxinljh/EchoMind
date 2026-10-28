/**
 * 账号中心积分客户端。
 *
 * 设置 CREDITS_APP_KEY 后进入「账号积分」模式：余额、扣费、充值入账都由
 * https://account.ljhsu.xin 负责，EchoMind 只做同源代理和本地用量明细。
 * 未设置时保持旧的自有 wallet 逻辑（本地开发、灰度与回滚用）。
 */

export type CreditsEnv = {
  /** 账号中心地址，默认 https://account.ljhsu.xin */
  CREDITS_API_URL?: string
  /** 接入应用 ID，默认 echomind */
  CREDITS_APP_ID?: string
  /** 应用服务端 key；设置后启用账号积分模式 */
  CREDITS_APP_KEY?: string
}

export type ConsumeResult =
  | { ok: true; balance: number; duplicate: boolean }
  | { ok: false; status: number; error: string }

const DEFAULT_URL = 'https://account.ljhsu.xin'
// 账号中心不可用时不能无限等待，否则平台模型请求会一起挂住。
const TIMEOUT_MS = 8_000

export function accountCreditsEnabled(env: CreditsEnv): boolean {
  return Boolean(env.CREDITS_APP_KEY)
}

function baseUrl(env: CreditsEnv): string {
  return (env.CREDITS_API_URL || DEFAULT_URL).replace(/\/$/, '')
}

function appId(env: CreditsEnv): string {
  return env.CREDITS_APP_ID || 'echomind'
}

type ApiResult = { ok: boolean; status: number; data: Record<string, unknown> }

async function call(env: CreditsEnv, path: string, init: RequestInit = {}): Promise<ApiResult | null> {
  try {
    const response = await fetch(`${baseUrl(env)}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.CREDITS_APP_KEY || ''}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    return { ok: response.ok, status: response.status, data }
  } catch {
    return null
  }
}

/**
 * 账号中心的 requestId 上限是 120 字符，而 EchoMind 的 requestId 本身可达 100。
 * 用 sha256(userId:requestId) 的 base64url 作为幂等键：确定性、定长，且不泄露原始 ID。
 */
async function idempotencyKey(userId: string, requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${requestId}`))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 读取账号余额；失败返回 null，由调用方决定是否 fail closed。 */
export async function readAccountBalance(env: CreditsEnv, userId: string): Promise<number | null> {
  const result = await call(
    env,
    `/api/apps/${encodeURIComponent(appId(env))}/credits?userId=${encodeURIComponent(userId)}`,
    { method: 'GET' },
  )
  if (!result?.ok) return null
  const balance = result.data.balance
  return typeof balance === 'number' && Number.isFinite(balance) ? balance : null
}

/** 幂等扣减；402 表示余额不足，其余失败按 503 返回（不能白给模型结果）。 */
export async function consumeAccountCredits(
  env: CreditsEnv,
  userId: string,
  requestId: string,
  credits: number,
): Promise<ConsumeResult> {
  const result = await call(env, `/api/apps/${encodeURIComponent(appId(env))}/credits/consume`, {
    method: 'POST',
    body: JSON.stringify({ userId, requestId: await idempotencyKey(userId, requestId), credits }),
  })
  if (!result) return { ok: false, status: 503, error: '无法连接账号中心，积分未结算，请稍后重试' }
  if (result.status === 402) return { ok: false, status: 402, error: '积分不足，请先充值' }
  if (!result.ok) return { ok: false, status: 503, error: '积分结算失败，请稍后重试' }
  return {
    ok: true,
    balance: typeof result.data.balance === 'number' ? result.data.balance : 0,
    duplicate: result.data.duplicate === true,
  }
}

/** 付费订单入账；账号中心按 (appId, orderId) 幂等，可安全重试。 */
export async function creditAccountOrder(
  env: CreditsEnv,
  order: { userId: string; orderId: string; credits: number; amountCents: number; paidAt: number },
): Promise<boolean> {
  const result = await call(env, `/api/apps/${encodeURIComponent(appId(env))}/credits/credit`, {
    method: 'POST',
    body: JSON.stringify({
      userId: order.userId,
      orderId: order.orderId,
      credits: order.credits,
      amountCents: order.amountCents,
      paidAt: order.paidAt,
    }),
  })
  return Boolean(result?.ok)
}
