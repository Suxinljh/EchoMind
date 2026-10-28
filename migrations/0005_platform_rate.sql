-- 平台模型按账号限流的固定窗口计数器。
-- Cloudflare Rate Limiting 绑定在本账号的生产环境实测不生效（40 个并发请求全部放行），
-- 因此用 D1 计数器作为真正生效的限额；每个用户一行，窗口按 60 秒对齐。
CREATE TABLE IF NOT EXISTS platform_rate (
  user_id TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
