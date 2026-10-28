-- 真正生效的限流计数表：Cloudflare Rate Limiting 绑定在本账号的生产环境实测不生效，
-- 因此 /api/model 与 /api/platform-model 的限额都落在 D1 固定窗口计数上。
-- scope 区分接口（model / platform），bucket 是账号 sub 或客户端 IP。
CREATE TABLE IF NOT EXISTS rate_limit (
  scope TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket)
);

-- 0005 的 platform_rate 合并进通用表：带上已有计数，避免改名瞬间重新获得配额。
INSERT INTO rate_limit (scope, bucket, window_start, count)
  SELECT 'platform', user_id, window_start, count FROM platform_rate WHERE 1
  ON CONFLICT(scope, bucket) DO NOTHING;
DROP TABLE IF EXISTS platform_rate;
