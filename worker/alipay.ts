/**
 * 支付宝 AI 网页应用收款（alipay.trade.page.pay）。
 *
 * 只使用 Web Crypto 做 RSA2 签名/验签，不依赖 Node SDK，可直接跑在 Workers。
 * 生产密钥只放 Worker secrets；沙箱密钥放 .dev.vars，不进入 Git。
 */

export type PayEnv = {
  DB: D1Database
  ALIPAY_APP_ID?: string
  ALIPAY_PRIVATE_KEY?: string
  ALIPAY_PUBLIC_KEY?: string
  ALIPAY_GATEWAY?: string
  ALIPAY_NOTIFY_URL?: string
  ALIPAY_RETURN_URL?: string
  PAY_ADMIN_TOKEN?: string
}

export type CreditPackage = { id: string; label: string; amountCents: number; credits: number }

/** 1 积分 = ¥0.01，与平台模型的成本倍率计费保持一致。 */
export const PACKAGES: Record<string, CreditPackage> = {
  basic: { id: 'basic', label: '100 积分', amountCents: 100, credits: 100 },
  standard: { id: 'standard', label: '1000 积分', amountCents: 1000, credits: 1000 },
  pro: { id: 'pro', label: '5000 积分', amountCents: 5000, credits: 5000 },
}

/** 自定义充值额度：最低 50 积分（¥0.50），最高 1,000,000 积分（¥10,000）。 */
export const MIN_CUSTOM_CREDITS = 50
export const MAX_CUSTOM_CREDITS = 1_000_000

/** 自定义额度按 1 积分 = ¥0.01 动态计价，因此金额（分）等于积分数量。 */
export function customPackage(credits: number): CreditPackage | null {
  if (!Number.isSafeInteger(credits) || credits < MIN_CUSTOM_CREDITS || credits > MAX_CUSTOM_CREDITS) return null
  return { id: 'custom', label: `${credits} 积分`, amountCents: credits, credits }
}

const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
const encoder = new TextEncoder()

function base64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function derFrom(value: string): ArrayBuffer {
  const base64 = value.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function privateKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', derFrom(value), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

async function publicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', derFrom(value), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
}

function timestamp(): string {
  // 支付宝要求 yyyy-MM-dd HH:mm:ss（东八区）。
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/** 请求签名包含 sign_type；异步通知/同步回跳验签排除 sign 与 sign_type。 */
function canonical(params: Record<string, string>, excludeSignType: boolean): string {
  return Object.keys(params)
    .filter(key => key !== 'sign' && (!excludeSignType || key !== 'sign_type') && params[key] !== '' && params[key] != null)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export function payConfig(env: PayEnv, request: Request): { appId: string; privateKey: string; publicKey: string; gateway: string; notifyUrl: string; returnUrl: string; origin: string } | null {
  if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) return null
  const origin = new URL(request.url).origin
  return {
    appId: env.ALIPAY_APP_ID,
    privateKey: env.ALIPAY_PRIVATE_KEY,
    publicKey: env.ALIPAY_PUBLIC_KEY,
    gateway: env.ALIPAY_GATEWAY || SANDBOX_GATEWAY,
    notifyUrl: env.ALIPAY_NOTIFY_URL || `${origin}/api/pay/notify`,
    returnUrl: env.ALIPAY_RETURN_URL || `${origin}/api/pay/return`,
    origin,
  }
}

async function signParams(params: Record<string, string>, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(canonical(params, false)))
  return base64(signature)
}

async function verifyParams(params: Record<string, string>, key: CryptoKey): Promise<boolean> {
  const signature = params.sign
  if (!signature) return false
  try {
    const raw = Uint8Array.from(atob(signature), char => char.charCodeAt(0))
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, raw, encoder.encode(canonical(params, true)))
  } catch {
    // 非法 base64 或签名格式不能让整个通知/回跳变成 500。
    return false
  }
}

/** 生成页面跳转表单（必须由浏览器渲染并提交，不能当 URL 用）。 */
export async function buildPagePayForm(
  env: PayEnv,
  request: Request,
  order: { outTradeNo: string; amountCents: number; subject: string },
): Promise<string> {
  const config = payConfig(env, request)
  if (!config) throw new Error('支付尚未配置')
  const key = await privateKey(config.privateKey)
  const params: Record<string, string> = {
    app_id: config.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.outTradeNo,
      total_amount: (order.amountCents / 100).toFixed(2),
      subject: order.subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    }),
  }
  params.sign = await signParams(params, key)

  const inputs = Object.entries(params)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join('')
  return `<!doctype html><html><body><form id="alipay-submit" method="POST" action="${escapeHtml(config.gateway)}?charset=utf-8">${inputs}</form><script>document.getElementById('alipay-submit').submit()</script></body></html>`
}

async function callApi(env: PayEnv, request: Request, method: string, bizContent: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = payConfig(env, request)
  if (!config) throw new Error('支付尚未配置')
  const key = await privateKey(config.privateKey)
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  }
  params.sign = await signParams(params, key)

  const response = await fetch(config.gateway, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  })
  const text = await response.text()
  const parsed = JSON.parse(text) as Record<string, unknown>
  const node = parsed[`${method.replace(/\./g, '_')}_response`]
  if (!node || typeof node !== 'object') throw new Error(`支付宝返回格式异常：${text.slice(0, 200)}`)
  const result = node as Record<string, unknown>
  if (result.code && result.code !== '10000') throw new Error(String(result.sub_msg || result.msg || result.code))
  return result
}

export async function tradeQuery(env: PayEnv, request: Request, outTradeNo: string): Promise<Record<string, unknown>> {
  return callApi(env, request, 'alipay.trade.query', { out_trade_no: outTradeNo })
}

export async function tradeClose(env: PayEnv, request: Request, outTradeNo: string): Promise<Record<string, unknown>> {
  return callApi(env, request, 'alipay.trade.close', { out_trade_no: outTradeNo })
}

export async function tradeRefund(env: PayEnv, request: Request, outTradeNo: string, amountCents: number, refundNo: string): Promise<Record<string, unknown>> {
  return callApi(env, request, 'alipay.trade.refund', {
    out_trade_no: outTradeNo,
    out_request_no: refundNo,
    refund_amount: (amountCents / 100).toFixed(2),
  })
}

export async function refundQuery(env: PayEnv, request: Request, outTradeNo: string, refundNo: string): Promise<Record<string, unknown>> {
  return callApi(env, request, 'alipay.trade.fastpay.refund.query', { out_trade_no: outTradeNo, out_request_no: refundNo })
}

/** 校验支付宝异步通知或同步回跳参数。 */
export async function verifyAlipayParams(env: PayEnv, params: Record<string, string>): Promise<boolean> {
  if (!env.ALIPAY_PUBLIC_KEY) return false
  try {
    const key = await publicKey(env.ALIPAY_PUBLIC_KEY)
    const valid = await verifyParams(params, key)
    if (!valid) return false
    if (params.app_id && env.ALIPAY_APP_ID && params.app_id !== env.ALIPAY_APP_ID) return false
    return true
  } catch {
    // 密钥配置错误或签名格式异常时按验签失败处理。
    return false
  }
}

export function parseFormParams(form: FormData): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) if (typeof value === 'string') params[key] = value
  return params
}

export async function getBalance(env: PayEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare('select balance from wallet where user_id = ?').bind(userId).first<{ balance: number }>()
  return row?.balance ?? 0
}

export async function createOrder(env: PayEnv, userId: string, pkg: CreditPackage): Promise<string> {
  const outTradeNo = `EM${Date.now()}${crypto.randomUUID().slice(0, 8).replace(/-/g, '')}`
  await env.DB.prepare(
    'insert into pay_order (out_trade_no, user_id, package_id, amount_cents, credits, status, created_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).bind(outTradeNo, userId, pkg.id, pkg.amountCents, pkg.credits, 'created', Date.now()).run()
  return outTradeNo
}

/**
 * 幂等入账（旧自有 wallet，本地开发/回滚模式）：
 * 订单置 paid、写台账、加余额在同一个 D1 batch（事务）里完成。
 * 第三步用 changes() 判断第二步是否真的插入了台账，重复通知不会重复加积分；
 * 若订单已是 paid 但台账缺失（历史半完成状态），下一次通知会补齐。
 */
export async function markOrderPaid(env: PayEnv, outTradeNo: string, tradeNo: string): Promise<boolean> {
  const now = Date.now()
  const order = await env.DB.prepare('select 1 as ok from pay_order where out_trade_no = ?').bind(outTradeNo).first<{ ok: number }>()
  if (!order) return false
  await env.DB.batch([
    env.DB.prepare("update pay_order set status = 'paid', trade_no = ?, paid_at = ? where out_trade_no = ? and status <> 'paid'")
      .bind(tradeNo, now, outTradeNo),
    env.DB.prepare(`insert into credit_ledger (id, user_id, delta, reason, ref, created_at)
      select ?, user_id, credits, 'recharge', out_trade_no, ?
      from pay_order
      where out_trade_no = ? and status = 'paid'
        and not exists (select 1 from credit_ledger where reason = 'recharge' and ref = ?)`)
      .bind(crypto.randomUUID(), now, outTradeNo, outTradeNo),
    env.DB.prepare(`insert into wallet (user_id, balance, updated_at)
      select user_id, credits, ? from pay_order
      where out_trade_no = ? and status = 'paid' and changes() = 1
      on conflict(user_id) do update set balance = balance + excluded.balance, updated_at = excluded.updated_at`)
      .bind(now, outTradeNo),
  ])
  return true
}

export type PaidOrder = { user_id: string; credits: number; amount_cents: number; paid_at: number }

/**
 * 只把订单置为 paid 并返回入账信息，不碰本地 wallet。
 * 账号积分模式下由调用方再调账号中心 credit（按 appId + orderId 幂等，可重试）。
 */
export async function markOrderPaidOnly(env: PayEnv, outTradeNo: string, tradeNo: string): Promise<PaidOrder | null> {
  const order = await env.DB.prepare('select user_id, credits, amount_cents, paid_at, status from pay_order where out_trade_no = ?')
    .bind(outTradeNo)
    .first<{ user_id: string; credits: number; amount_cents: number; paid_at: number | null; status: string }>()
  if (!order) return null
  const now = Date.now()
  if (order.status !== 'paid') {
    await env.DB.prepare("update pay_order set status = 'paid', trade_no = ?, paid_at = ? where out_trade_no = ? and status <> 'paid'")
      .bind(tradeNo, now, outTradeNo).run()
    return { user_id: order.user_id, credits: order.credits, amount_cents: order.amount_cents, paid_at: now }
  }
  return {
    user_id: order.user_id,
    credits: order.credits,
    amount_cents: order.amount_cents,
    paid_at: order.paid_at ?? now,
  }
}
