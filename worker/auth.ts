/**
 * 统一账号（LoginSuxin）的 OIDC 接入。
 *
 * 只保存 sub / 昵称 / 邮箱到签名 Cookie，练习记录仍留在浏览器；
 * 不建立数据库，也不上传任何录音或练习内容。
 */

const SESSION_COOKIE = 'echomind_account'
const FLOW_COOKIE = 'echomind_auth_flow'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const FLOW_TTL_SECONDS = 600
const DEFAULT_ISSUER = 'https://login.ljhsu.xin/api/auth'

type AuthEnv = Env & {
  OIDC_CLIENT_ID?: string
  OIDC_CLIENT_SECRET?: string
  OIDC_ISSUER?: string
  SESSION_SECRET?: string
}

type Account = { sub: string; name: string; email: string }
type SessionPayload = Account & { exp: number }
type FlowPayload = { state: string; verifier: string; returnTo: string; exp: number }

const encoder = new TextEncoder()

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function issuer(env: AuthEnv): string {
  return (env.OIDC_ISSUER || DEFAULT_ISSUER).replace(/\/$/, '')
}

function configured(env: AuthEnv): boolean {
  return Boolean(env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.SESSION_SECRET)
}

function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)))
}

function decodeJson<T>(value: string): T | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return JSON.parse(atob(padded)) as T
  } catch {
    return null
  }
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}

async function seal(secret: string, value: unknown): Promise<string> {
  const payload = encodeJson(value)
  return `${payload}.${await sign(secret, payload)}`
}

async function unseal<T>(secret: string, token: string): Promise<T | null> {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = await sign(secret, payload)
  if (signature.length !== expected.length) return null
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  if (diff !== 0) return null
  return decodeJson<T>(payload)
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAge}`
}

function clearCookie(name: string, secure: boolean): string {
  return cookieHeader(name, '', 0, secure)
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' })
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(null, { status: 302, headers })
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  return value
}

function withParam(path: string, key: string, value: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${key}=${encodeURIComponent(value)}`
}

export async function readAccount(request: Request, env: AuthEnv): Promise<Account | null> {
  if (!env.SESSION_SECRET) return null
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return null
  const payload = await unseal<SessionPayload>(env.SESSION_SECRET, token)
  if (!payload || !payload.sub || payload.exp < nowSeconds()) return null
  return { sub: payload.sub, name: payload.name, email: payload.email }
}

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (!configured(env)) return new Response('统一登录尚未配置。', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  const url = new URL(request.url)
  const verifier = randomToken(48)
  const challenge = base64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
  const state = randomToken(16)
  const returned = safeReturnTo(url.searchParams.get('returnTo'))
  const flow = await seal(env.SESSION_SECRET!, { state, verifier, returnTo: returned, exp: nowSeconds() + FLOW_TTL_SECONDS })

  const authorize = new URL(`${issuer(env)}/oauth2/authorize`)
  authorize.search = new URLSearchParams({
    client_id: env.OIDC_CLIENT_ID!,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  return redirect(authorize.toString(), [cookieHeader(FLOW_COOKIE, flow, FLOW_TTL_SECONDS, isSecure(request))])
}

export async function handleCallback(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const secure = isSecure(request)
  if (!configured(env)) return new Response('统一登录尚未配置。', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  if (url.searchParams.get('error')) {
    const reason = url.searchParams.get('error_description') || url.searchParams.get('error') || '授权被取消'
    return redirect(withParam('/', 'auth_error', reason), [clearCookie(FLOW_COOKIE, secure)])
  }

  const flowToken = readCookie(request, FLOW_COOKIE)
  const flow = flowToken ? await unseal<FlowPayload>(env.SESSION_SECRET!, flowToken) : null
  if (!flow || flow.exp < nowSeconds()) {
    return redirect(withParam('/', 'auth_error', '登录请求已过期，请重新登录'), [clearCookie(FLOW_COOKIE, secure)])
  }
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!code || !state || state !== flow.state) {
    return redirect(withParam('/', 'auth_error', '授权回调校验失败，请重试'), [clearCookie(FLOW_COOKIE, secure)])
  }

  const tokenResponse = await fetch(`${issuer(env)}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/auth/callback`,
      code_verifier: flow.verifier,
    }),
  })
  if (!tokenResponse.ok) {
    return redirect(withParam('/', 'auth_error', `换取令牌失败（HTTP ${tokenResponse.status}）`), [clearCookie(FLOW_COOKIE, secure)])
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string; access_token?: string }
  const claims = tokens.id_token ? decodeJson<Record<string, unknown>>(tokens.id_token.split('.')[1] || '') : null
  const audiences = claims && (Array.isArray(claims.aud) ? claims.aud : [claims.aud])
  if (!claims || claims.iss !== issuer(env) || !audiences?.includes(env.OIDC_CLIENT_ID) || typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() || typeof claims.sub !== 'string') {
    return redirect(withParam('/', 'auth_error', '身份令牌校验失败，请重试'), [clearCookie(FLOW_COOKIE, secure)])
  }

  // id_token 只带标准声明，昵称和邮箱从 userinfo 取；取不到也不影响登录。
  let profile: { name?: string; email?: string } | null = null
  if (tokens.access_token) {
    const response = await fetch(`${issuer(env)}/oauth2/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    if (response.ok) profile = (await response.json()) as { name?: string; email?: string }
  }

  const account: Account = {
    sub: claims.sub,
    name: typeof profile?.name === 'string' ? profile.name : '',
    email: typeof profile?.email === 'string' ? profile.email : '',
  }
  const session = await seal(env.SESSION_SECRET!, { ...account, exp: nowSeconds() + SESSION_TTL_SECONDS })
  return redirect(withParam(flow.returnTo || '/', 'auth_ok', '1'), [
    cookieHeader(SESSION_COOKIE, session, SESSION_TTL_SECONDS, secure),
    clearCookie(FLOW_COOKIE, secure),
  ])
}

export async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const secure = isSecure(request)
  const cookies = [clearCookie(SESSION_COOKIE, secure), clearCookie(FLOW_COOKIE, secure)]
  if (!configured(env)) return redirect('/', cookies)

  // 同时结束统一账号的登录态；未带 id_token_hint 时 IdP 会显示一次确认页。
  const endSession = new URL(`${issuer(env)}/oauth2/end-session`)
  endSession.search = new URLSearchParams({
    client_id: env.OIDC_CLIENT_ID!,
    post_logout_redirect_uri: `${url.origin}/`,
  }).toString()
  return redirect(endSession.toString(), cookies)
}

export async function handleMe(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'GET') return Response.json({ error: '只支持 GET' }, { status: 405, headers: { 'Cache-Control': 'no-store' } })
  const account = await readAccount(request, env)
  return Response.json({ user: account }, { headers: { 'Cache-Control': 'no-store' } })
}
