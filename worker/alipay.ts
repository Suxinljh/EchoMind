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

/** 目前只开放 1 分钱的沙箱体验包，避免误收真实款项。 */
export const PACKAGES: Record<string, CreditPackage> = {
  test: { id: 'test', label: '体验包 · 100 积分', amountCents: 1, credits: 100 },
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
  const raw = Uint8Array.from(atob(signature), char => char.charCodeAt(0))
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, raw, encoder.encode(canonical(params, true)))
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
  const key = await publicKey(env.ALIPAY_PUBLIC_KEY)
  const valid = await verifyParams(params, key)
  if (!valid) return false
  if (params.app_id && env.ALIPAY_APP_ID && params.app_id !== env.ALIPAY_APP_ID) return false
  return true
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

/** 幂等入账：只有第一次把订单置为 paid 时才增加积分。 */
export async function markOrderPaid(env: PayEnv, outTradeNo: string, tradeNo: string): Promise<boolean> {
  const now = Date.now()
  const order = await env.DB.prepare('select user_id, credits, status from pay_order where out_trade_no = ?').bind(outTradeNo).first<{ user_id: string; credits: number; status: string }>()
  if (!order) return false
  if (order.status === 'paid') return true
  const updated = await env.DB.prepare("update pay_order set status = 'paid', trade_no = ?, paid_at = ? where out_trade_no = ? and status <> 'paid'")
    .bind(tradeNo, now, outTradeNo)
    .run()
  if (!updated.meta.changes) return true
  await env.DB.batch([
    env.DB.prepare('insert into wallet (user_id, balance, updated_at) values (?, ?, ?) on conflict(user_id) do update set balance = balance + excluded.balance, updated_at = excluded.updated_at')
      .bind(order.user_id, order.credits, now),
    env.DB.prepare('insert into credit_ledger (id, user_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), order.user_id, order.credits, 'recharge', outTradeNo, now),
  ])
  return true
}
