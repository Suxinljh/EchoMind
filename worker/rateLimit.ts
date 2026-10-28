/**
 * D1 固定窗口限流。
 *
 * Cloudflare Rate Limiting 绑定在本账号的生产环境实测不生效（40 个并发请求全部放行），
 * 因此真正生效的限额放在 D1：每个 (scope, bucket) 一行，窗口按 windowMs 对齐。
 * 先读后写：超限时只读不写，避免被刷时把 D1 写入配额放大成每个请求一次写。
 */
export async function allowRequest(
  env: Env,
  scope: string,
  bucket: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs
  try {
    const current = await env.DB.prepare('select window_start, count from rate_limit where scope = ? and bucket = ?')
      .bind(scope, bucket)
      .first<{ window_start: number; count: number }>()
    const used = current && current.window_start === windowStart ? current.count : 0
    if (used >= limit) return false
    await env.DB.prepare(
      `insert into rate_limit (scope, bucket, window_start, count) values (?, ?, ?, ?)
       on conflict(scope, bucket) do update set count = excluded.count, window_start = excluded.window_start`,
    ).bind(scope, bucket, windowStart, used + 1).run()
    return true
  } catch (error) {
    // 限流不应因为表缺失等基础设施问题阻断正常调用，但要能在日志里看到。
    console.error('[rate-limit] 计数失败', scope, error)
    return true
  }
}
