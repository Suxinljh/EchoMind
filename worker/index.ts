import { CLOUD_POLICY, MAX_REQUEST_BYTES, TIMEOUT_MS, ProviderFailure, checkDeepSeek, createRateLimiter, normalizeBaseURL, providerMessage, validateModelRequest } from '../src/modelProtocol'
import type { ModelRequest } from '../src/modelProtocol'
import { accountCreditsEnabled, creditAccountOrder, readAccountBalance } from './accountCredits'
import type { CreditsEnv } from './accountCredits'
import { handleCallback, handleLogin, handleLogout, handleMe, readAccount } from './auth'
import { handleCredits, handlePlatformModel, type PlatformEnv } from './platform'
import { allowRequest } from './rateLimit'
import { handleSync, type SyncEnv } from './sync'
import {
  PACKAGES,
  buildPagePayForm,
  createOrder,
  customPackage,
  getBalance,
  markOrderPaid,
  markOrderPaidOnly,
  MAX_CUSTOM_CREDITS,
  MIN_CUSTOM_CREDITS,
  parseFormParams,
  refundQuery,
  tradeClose,
  tradeQuery,
  tradeRefund,
  verifyAlipayParams,
  type PayEnv,
} from './alipay'

const modelFiles = new Set(['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'])
const modelPrefix = '/models/zipformer-2025/'
// 按 CF-Connecting-IP 的 isolate 内限流；正常一次 15 题面试约 17 次调用，30 次/分钟足够。
const modelLimiter = createRateLimiter(30, 60_000)
// 平台模型直接消耗账号积分调上游供应商，比自带 Key 的 /api/model 更需要防刷。
const platformLimiter = createRateLimiter(20, 60_000)

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

async function readRequest(request: Request): Promise<ModelRequest> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('请求内容不完整')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('请求内容过大') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return validateModelRequest(JSON.parse(new TextDecoder().decode(bytes)), CLOUD_POLICY)
}

/** 平台模型限流：先于扣费与上游调用，避免被刷时先产生成本。 */
async function limitPlatformModel(request: Request, env: Env): Promise<Response | null> {
  const key = request.headers.get('cf-connecting-ip') || 'unknown'
  let allowed = false
  if (env.PLATFORM_RATE_LIMITER) {
    try { allowed = (await env.PLATFORM_RATE_LIMITER.limit({ key })).success }
    catch { allowed = platformLimiter(key) }
  } else {
    allowed = platformLimiter(key)
  }
  // 绑定在本账号的生产环境不生效，按 IP 的 D1 计数才是真正的前置限额。
  if (allowed) allowed = await allowRequest(env, 'platform_ip', key, 20, 60_000)
  if (!allowed) return json(429, { error: '请求过于频繁，请稍后再试' }, { 'Retry-After': '60' })
  return null
}

async function handleModel(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json(403, { error: '只接受同源请求' })
  const client = request.headers.get('cf-connecting-ip') || 'unknown'
  let allowed = false
  if (env.MODEL_RATE_LIMITER) {
    // 绑定按数据中心计数；本地 dev 不支持时回退到 isolate 内存限流。
    try { allowed = (await env.MODEL_RATE_LIMITER.limit({ key: client })).success }
    catch { allowed = modelLimiter(client) }
  } else {
    allowed = modelLimiter(client)
  }
  // 绑定在本账号的生产环境不生效（实测连续请求全部放行），D1 计数才是真正生效的 30 次/60 秒。
  if (allowed) allowed = await allowRequest(env, 'model', client, 30, 60_000)
  if (!allowed) return json(429, { error: '请求过于频繁，请稍后再试' }, { 'Retry-After': '60' })
  let input: ModelRequest | undefined
  const controller = new AbortController()
  // 客户端断开时立即中止上游请求，避免继续计费。
  const abortFromClient = () => controller.abort()
  request.signal.addEventListener('abort', abortFromClient)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    input = await readRequest(request)
    const url = normalizeBaseURL(input.provider, CLOUD_POLICY)
    const isDeepSeek = new URL(url).hostname === 'api.deepseek.com'
    timer = setTimeout(() => controller.abort(), input.testOnly ? TIMEOUT_MS.test : TIMEOUT_MS.normal)
    if (input.testOnly && isDeepSeek) await checkDeepSeek(input.provider, url, controller.signal)
    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.provider.model.trim(),
        messages: input.messages,
        temperature: 0.2,
        ...(input.testOnly ? { max_tokens: 16 } : input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) throw new ProviderFailure(response.status, body)
    const result = JSON.parse(body) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const content = result.choices?.[0]?.message?.content
    if (!content?.trim()) throw new Error('模型响应缺少文本内容')
    return json(200, { text: content, usage: { input: result.usage?.prompt_tokens, output: result.usage?.completion_tokens } })
  } catch (error) {
    if (error instanceof ProviderFailure) return json(error.status, { error: providerMessage(error.status, error.body, input?.provider.apiKey || '') })
    if (controller.signal.aborted) return json(504, { error: `模型服务在 ${input?.testOnly ? TIMEOUT_MS.test / 1000 : TIMEOUT_MS.normal / 1000} 秒内未响应` })
    return json(400, { error: error instanceof Error ? error.message : String(error) })
  } finally { if (timer) clearTimeout(timer); request.signal.removeEventListener('abort', abortFromClient) }
}

async function handleModelFile(request: Request, env: Env, name: string): Promise<Response> {
  if (!modelFiles.has(name)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { 'Cache-Control': 'no-store' } })
  const object = await env.MODELS.get(`echomind/${name}`)
  if (!object) return new Response('Model file not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'Content-Type': name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=86400',
      ETag: object.httpEtag,
    },
  })
}


/**
 * 支付成功后的入账入口。
 * - 账号积分模式：只把订单置 paid，再调账号中心 credit（按 appId + orderId 幂等，失败可重试）。
 * - 旧模式：沿用本地 wallet 原子入账。
 * 返回 false 时异步通知要回 failure，让支付宝继续重试。
 */
async function grantPaidOrder(payEnv: Env & PayEnv & CreditsEnv, outTradeNo: string, tradeNo: string): Promise<boolean> {
  if (!outTradeNo) return true
  if (accountCreditsEnabled(payEnv)) {
    const order = await markOrderPaidOnly(payEnv, outTradeNo, tradeNo)
    // 不是本站创建的订单：无需入账，也不要让支付宝一直重试。
    if (!order) return true
    return creditAccountOrder(payEnv, {
      userId: order.user_id,
      orderId: outTradeNo,
      credits: order.credits,
      amountCents: order.amount_cents,
      paidAt: order.paid_at,
    })
  }
  await markOrderPaid(payEnv, outTradeNo, tradeNo)
  return true
}

async function handlePay(request: Request, env: Env & CreditsEnv): Promise<Response> {
  const payEnv = env as Env & PayEnv & CreditsEnv
  const url = new URL(request.url)

  if (url.pathname === '/api/pay/balance') {
    const account = await readAccount(request, env)
    if (!account) return json(401, { error: '请先登录' })
    const balance = accountCreditsEnabled(payEnv) ? await readAccountBalance(payEnv, account.sub) : await getBalance(payEnv, account.sub)
    if (balance === null) return json(503, { error: '无法读取账号积分，请稍后重试' })
    return json(200, { balance })
  }

  if (url.pathname === '/api/pay/create') {
    if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
    const account = await readAccount(request, env)
    if (!account) return json(401, { error: '请先登录' })
    const body = await request.json().catch(() => ({})) as { packageId?: string; credits?: number }
    // 套餐与自定义额度二选一；自定义额度一律服务端重算金额，不信任客户端价格。
    const pkg = body.packageId
      ? PACKAGES[body.packageId]
      : customPackage(typeof body.credits === 'number' ? body.credits : Number.NaN)
    if (!pkg) {
      return json(400, {
        error: body.packageId
          ? '未知的充值套餐'
          : `自定义充值积分必须是 ${MIN_CUSTOM_CREDITS}～${MAX_CUSTOM_CREDITS} 的整数`,
      })
    }
    const outTradeNo = await createOrder(payEnv, account.sub, pkg)
    const formHtml = await buildPagePayForm(payEnv, request, {
      outTradeNo,
      amountCents: pkg.amountCents,
      subject: `EchoMind ${pkg.label}`,
    })
    return json(200, { outTradeNo, formHtml })
  }

  // 支付宝异步通知：必须验签、幂等、返回纯文本 success。
  if (url.pathname === '/api/pay/notify') {
    if (request.method !== 'POST') return new Response('failure', { status: 405 })
    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('application/x-www-form-urlencoded')) return new Response('failure', { status: 415 })
    let params: Record<string, string>
    try { params = parseFormParams(await request.formData()) } catch { return new Response('failure', { status: 400 }) }
    const verified = await verifyAlipayParams(payEnv, params)
    if (!verified) return new Response('failure', { status: 400 })
    // 只记录已验证的通知（不存签名/买家信息），避免未验签请求刷大 pay_notify。
    try {
      await payEnv.DB.prepare('insert into pay_notify (id, out_trade_no, payload, created_at) values (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), params.out_trade_no || '', JSON.stringify({
          verified: true,
          trade_status: params.trade_status || '',
          app_id: params.app_id || '',
          has_sign: Boolean(params.sign),
          keys: Object.keys(params).sort().slice(0, 100),
        }), Date.now())
        .run()
    } catch { /* 诊断记录失败不影响通知应答 */ }
    if (params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED') {
      try {
        if (!(await grantPaidOrder(payEnv, params.out_trade_no || '', params.trade_no || ''))) {
          return new Response('failure', { status: 500 })
        }
      } catch {
        // 订单置 paid 成功但入账失败时返回 failure，由支付宝重试；入账接口幂等。
        return new Response('failure', { status: 500 })
      }
    }
    return new Response('success', { headers: { 'content-type': 'text/plain' } })
  }

  // 同步回跳只用于展示结果，最终以查询/异步通知为准。
  if (url.pathname === '/api/pay/return') {
    const params = Object.fromEntries(url.searchParams.entries())
    if (!(await verifyAlipayParams(payEnv, params))) return Response.redirect(`${url.origin}/?pay=invalid`, 302)
    const outTradeNo = params.out_trade_no || ''
    try {
      const order = await payEnv.DB.prepare('select status from pay_order where out_trade_no = ?').bind(outTradeNo).first<{ status: string }>()
      if (order?.status === 'paid') return Response.redirect(`${url.origin}/?pay=success`, 302)
      const result = await tradeQuery(payEnv, request, outTradeNo)
      if (result.trade_status === 'TRADE_SUCCESS' || result.trade_status === 'TRADE_FINISHED') {
        const granted = await grantPaidOrder(payEnv, outTradeNo, String(result.trade_no || ''))
        return Response.redirect(`${url.origin}/?pay=${granted ? 'success' : 'pending'}`, 302)
      }
    } catch {
      // 查询失败时交给异步通知或后续查询补偿。
    }
    return Response.redirect(`${url.origin}/?pay=pending`, 302)
  }

  if (url.pathname.startsWith('/api/pay/admin/')) {
    if (request.method !== 'POST') return json(405, { error: '只支持 POST' })
    const token = request.headers.get('x-pay-admin') || ''
    if (!payEnv.PAY_ADMIN_TOKEN || token !== payEnv.PAY_ADMIN_TOKEN) return json(401, { error: '无权限' })
    const body = await request.json().catch(() => ({})) as { outTradeNo?: string; amountCents?: number; refundNo?: string }
    if (!body.outTradeNo) return json(400, { error: '缺少 outTradeNo' })
    try {
      if (url.pathname.endsWith('/refund')) return json(200, { result: await tradeRefund(payEnv, request, body.outTradeNo, body.amountCents || 1, body.refundNo || `R${Date.now()}`) })
      if (url.pathname.endsWith('/refund-query')) return json(200, { result: await refundQuery(payEnv, request, body.outTradeNo, body.refundNo || '') })
      if (url.pathname.endsWith('/close')) return json(200, { result: await tradeClose(payEnv, request, body.outTradeNo) })
      if (url.pathname.endsWith('/query')) return json(200, { result: await tradeQuery(payEnv, request, body.outTradeNo) })
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return json(404, { error: 'Not found' })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (pathname === '/auth/login') return handleLogin(request, env)
    if (pathname === '/auth/callback') return handleCallback(request, env)
    if (pathname === '/auth/logout') return handleLogout(request, env)
    if (pathname === '/api/me') return handleMe(request, env)
    if (pathname === '/api/platform-model') {
      const limited = await limitPlatformModel(request, env)
      return limited ?? handlePlatformModel(request, env as Env & PlatformEnv)
    }
    if (pathname === '/api/sync') return handleSync(request, env as Env & SyncEnv)
    if (pathname === '/api/credits' || pathname === '/api/credits/usage') return handleCredits(request, env as Env & PlatformEnv)
    if (pathname.startsWith('/api/pay/')) return handlePay(request, env as Env & CreditsEnv)
    if (pathname === '/api/model') return handleModel(request, env)
    if (pathname.startsWith(modelPrefix)) return handleModelFile(request, env, pathname.slice(modelPrefix.length))
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
