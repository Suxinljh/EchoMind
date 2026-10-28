# 账号积分与退款设计

> 状态：账号中心已在 **LoginSuxin** 仓库上线；EchoMind 已切换为账号积分模式（余额/扣费/充值入账走账号中心，本地 `wallet` 冻结为归档）。  
> 账号中心：`https://account.ljhsu.xin`（旧 `login.ljhsu.xin` 308 跳转）。  
> 退款规则文案：[`refund-policy.md`](./refund-policy.md)。

## 1. 结论与原则

1. **积分归属账号（OIDC `sub`），不归属单个应用**；账号中心是钱包、充值、消费台账、退款申请与审核的唯一事实来源。
2. **当前不存在赠送积分**；所有 `credit_lot` 都是付费充值。若以后加入赠送，需要重新定义可退积分和消耗顺序。
3. **一个账号同一时间一笔处理中的退款**；按账号维度，不按应用维度。
4. **可退金额是预估值**：申请时按当时台账估算；审核时按审核完成时的余额重算，新计费从预估金额中扣减。
5. **12 个月按审核时计算**：审核时订单已超过 12 个月的，自动原路退款不可用，转人工处理。
6. **不冻结积分**：申请后用户仍可消费；审核重算会相应降低最终退款。这样符合“计费延迟”规则，也避免冻结导致新计费无法结算。
7. **显著提示**：充值页与退款申请页必须以加粗、独立弹窗或勾选确认提示退款限制。

## 2. 域名与页面

| 用途 | 地址 |
| --- | --- |
| 登录 / OIDC | `https://account.ljhsu.xin/login`、`/api/auth/*` |
| 账号中心 | `https://account.ljhsu.xin/` |
| 积分与用量 | `https://account.ljhsu.xin/credits` |
| 退款申请 | `https://account.ljhsu.xin/refunds` |
| 服务协议与政策（含退款规则） | `https://account.ljhsu.xin/terms/refund` |
| 管理员审核 | `https://account.ljhsu.xin/admin/refunds` |

- 旧 `login.ljhsu.xin` 由 Worker 308 到 `account.ljhsu.xin`；旧 host-only 会话不会带过去，用户重新登录。
- OIDC issuer 从 `https://login.ljhsu.xin/api/auth` 变为 `https://account.ljhsu.xin/api/auth`；各应用更新 `OIDC_ISSUER`、发现文档和回调白名单。

## 3. 账号中心实现（LoginSuxin）

- 数据库：D1 `login-suxin`；迁移 `migrations/0001_credits.sql`。
- 并发：每个账号一个 Durable Object `AccountDO`，串行化消费、退款申请、退款审核；避免计费延迟下的并发退款。
- 服务端：`src/worker.ts` 暴露账号/应用/管理员接口；`src/credits.ts` 提供余额、预估与原路退款适配器。
- 前端：`/credits`、`/refunds`、`/terms/refund`、`/admin/refunds`；`src/client/pages.tsx`。
- 原路退款：当前通过 EchoMind 的支付宝商户退款接口（`ECHOMIND_REFUND_URL` + `ECHOMIND_PAY_ADMIN_TOKEN`）；后续可替换为账号中心自己的支付适配器。

## 4. 数据模型

```sql
-- 付费积分批次：每笔充值订单一个 lot；无赠送。
credit_lot (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX credit_lot_app_order_idx ON credit_lot (app_id, order_id);

-- 统一台账：充值、消费、退款、导入、调整。
credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,   -- recharge/consume/refund/import/adjust
  ref TEXT,
  created_at INTEGER NOT NULL
);

-- 应用消费幂等。requestId 由应用生成，幂等键必须带 user_id，
-- 否则不同用户撞到同一 requestId 会被当成重复请求而不扣费。
app_usage (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id, request_id)
);

-- 退款申请与明细。
refund_request (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,      -- user/platform
  status TEXT NOT NULL,    -- pending/reviewing/completed/rejected/failed/expired
  estimated_credits INTEGER NOT NULL,
  estimated_cents INTEGER NOT NULL,
  final_credits INTEGER NOT NULL,
  final_cents INTEGER NOT NULL,
  manual_cents INTEGER NOT NULL,
  note TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  completed_at INTEGER
);
CREATE UNIQUE INDEX refund_one_active
  ON refund_request (user_id)
  WHERE status IN ('pending', 'reviewing', 'approved');

refund_item (
  id TEXT PRIMARY KEY,
  refund_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  credits INTEGER NOT NULL,        -- 申请时的可退积分
  amount_cents INTEGER NOT NULL,   -- 申请时的预估金额
  final_credits INTEGER NOT NULL,  -- 审核时重算
  final_cents INTEGER NOT NULL,
  status TEXT NOT NULL,            -- pending/processing/refunded/manual/failed/skipped
  refund_no TEXT,
  provider_ref TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
```

余额 = `sum(credit_lot.remaining)`；所有扣减/退款写 `credit_ledger`。

## 5. 消费与退款算法

### 5.1 应用消费

`POST /api/apps/:appId/credits/consume`

```json
{ "userId": "oidc-sub", "requestId": "uuid", "credits": 30 }
```

1. 校验应用凭证（`APP_API_KEYS`）。
2. 严格校验参数：`credits` 必须是 1～100000 的 JSON number 整数，`requestId` ≤120 字符；类型不对或越界直接 400，不做默认值兜底（否则 `"30"` 会被当成 1 积分扣费）。
3. 以 `(app_id, user_id, request_id)` 查 `app_usage`；已存在直接返回原结果，不重复扣费。
4. 余额不足 → 402；否则按 `paid_at` **FIFO** 扣减 `credit_lot.remaining`，写台账和 `app_usage`。
5. Durable Object 串行化同一账号的消费/退款。

### 5.2 可退预估

`GET /api/account/refunds/estimate`（登录会话）

- 取该账号 `remaining > 0` 的付费 lot。
- 单 lot 可退金额：`floor(remaining * amount_cents / credits)`；单笔向下取整到分。
- 汇总 `refundable_credits` / `estimated_cents`；返回订单明细与是否超过 12 个月。
- 页面显著提示：**这是截至当前的预估值；审核期间新计费会从最终退款中扣减。**

### 5.3 申请

`POST /api/account/refunds`（登录会话 + 同源）

1. 校验无处理中退款；可退积分 > 0；预估金额 ≥ 0.01 元。
2. 先把超过 14 天未审核的 `pending` 申请置为 `expired`（其未处理明细置为 `skipped`），否则唯一索引会让新申请直接插入失败。
3. 创建 `refund_request(status='pending')` 与 `refund_item`（按 lot 拆分）。
4. **不冻结积分**；用户仍可消费，审核时重算最终金额。
5. 一账号一笔由唯一部分索引 `refund_one_active` 保证；处理中的申请读侧同样只认 14 天内的，避免界面一直显示已失效的申请。

### 5.4 审核（按审核时计算）

`POST /api/admin/refunds/:id/review`（admin 会话或 `CREDITS_ADMIN_TOKEN`）

1. 读取申请与 lot；对每个 item：`final_credits = min(申请积分, 当前 lot.remaining)`；`final_cents = floor(final_credits * amount_cents / credits)`。
2. **12 个月按审核时判断**：`paid_at < now - 12个月` → 人工；否则自动原路退款。
3. 自动项调用 EchoMind 支付宝退款接口（10 秒超时）；成功则扣减 lot、写退款台账、标记 `refunded`；失败标记 `failed`，lot 不动。超时视为“结果未知”，提示先到支付宝后台核对再重试，避免重复退款。
4. 人工项扣减 lot、写退款台账、标记 `manual`，由客服邮箱跟进；`manual_cents` 记录人工金额。
5. 最终金额 = 成功自动项 + 人工项；`final_cents` 可小于 `estimated_cents`（审核期间新消费）。
6. 最终不足 0.01 元 → 拒绝并说明，同时把未处理明细置为 `skipped`（不留悬挂的 `pending`）。
7. 申请状态为 `failed` 时可重新审核：`refunded` / `manual` / `skipped` 的明细直接跳过，只重试 `failed` 的订单，所以已退款订单不会被重复处理。
8. 管理员审核接口返回更新后的 `request`（含 `status` 与 `final_cents`），前端据此提示“部分失败可重试”或“金额不足被拒绝”。

### 5.5 平台原因退款

`POST /api/admin/refunds/platform`（管理员）

- 由管理员按账号发起，不要求用户先提交申请；
- 按未使用付费积分对价退款；同样按审核时判断 12 个月，自动/人工；
- 复用同一 `AccountDO` 和退款明细，记录原因与审核人。

## 6. API 清单（账号中心）

| 方法/路径 | 调用方 | 作用 |
| --- | --- | --- |
| `GET /api/account/credits` | 浏览器（登录） | 余额、可退预估、最近用量 |
| `GET /api/account/credits/usage` | 浏览器（登录） | 跨应用用量 |
| `GET /api/account/refunds/estimate` | 浏览器（登录） | 可退预估与订单明细 |
| `GET/POST /api/account/refunds` | 浏览器（登录） | 退款记录 / 提交申请 |
| `GET /api/admin/refunds` | 管理员 | 退款申请列表 |
| `GET /api/admin/refunds/:id` | 管理员 | 申请明细 |
| `POST /api/admin/refunds/:id/review` | 管理员 | 审核、重算、原路退款 |
| `POST /api/admin/refunds/platform` | 管理员 | 平台原因退款 |
| `POST /api/admin/credits/import` | 管理员/脚本 | 存量积分导入（返回 `imported` / `duplicates` / `skipped` / `failed` / `balances`） |
| `POST /api/apps/:appId/credits/consume` | 接入应用服务端 | 幂等扣减 |
| `POST /api/apps/:appId/credits/credit` | 接入应用服务端 | 付费订单入账（幂等） |
| `GET /api/apps/:appId/credits?userId=` | 接入应用服务端 | 只读余额 + 本应用最近 20 条台账 |

EchoMind 后续只保留同源代理：`/api/credits`、`/api/credits/usage` 转发账号中心；`/api/platform-model` 内部调用账号中心 `consume`（`appId=echomind`，复用 `platform_request` 的 requestId）。

## 7. 页面与文案

账号中心：

- `/credits`：可用积分、可退付费积分、预估可退、处理中退款、最近用量；按钮进入 `/refunds`、`/terms/refund`。
- `/refunds`：预估金额、显著提示、勾选确认、提交、处理中状态、退款记录、超过 12 个月的人工提示与客服邮箱。
- `/terms/refund`：《服务协议与政策》，包含隐私政策、用户协议与积分退款规则；实现在 `src/client/Legal.tsx`。
- `/admin/refunds`：管理员列表、通过/拒绝、最终金额与人工金额。

EchoMind 目标文案（账号中心上线后）：

- 标题：**账号积分与用量**。
- 说明：**积分跟随 Suxin 账号，可在接入的平台通用。充值在 EchoMind 模型设置中完成，退款请在账号中心处理。**
- 按钮：**账号中心**、**申请退款**（跳转 `https://account.ljhsu.xin/refunds`）。

> 在 EchoMind 完成钱包切换前，不要提前宣称“跨平台通用积分”。

## 8. EchoMind 迁移（已完成）

切换前先确认账号中心已上线、EchoMind 已部署新版代码，且本地钱包在导入窗口内停止写入。

1. **导入存量积分**：`node scripts/import-credits.mjs --remote` 先 dry-run，按 FIFO 计算 `remaining` 并与本地 `wallet` 对账；差额为 0 后加 `--apply --admin-token <CREDITS_ADMIN_TOKEN>`。脚本按每 500 条分片，返回 `imported` / `duplicates` / `skipped` / `failed` / `balances`，并自动核对账号中心余额。导入是**只插入**语义：同一 `appId + orderId` 已存在时不覆盖，若积分/剩余/金额/支付时间/归属账号与本次导入不一致，会以 `skipped` 返回差异说明，需要人工确认后再处理。
2. **切换平台模型扣费**：`worker/platform.ts` 在设置了 `CREDITS_APP_KEY` 时调账号中心 `consume`（幂等键 `sha256(sub:requestId)`），扣费成功后才返回模型结果；账号中心不可用返回 503，不白给结果。
3. **切换充值入账**：`worker/index.ts` 的 `grantPaidOrder` 在账号模式下只把 `pay_order` 置 paid，再调账号中心 `credit`（按 appId + orderId 幂等）；异步通知失败返回 `failure`，由支付宝重试。
4. **切换读取与 UI**：`/api/credits` 返回账号中心的 `balance` 与 `managed: true`；`/api/credits/usage` 继续用本地 `model_usage` 提供 token/模型明细；积分弹窗在 `managed` 时显示“账号中心”和“申请退款”链接。
5. **冻结旧钱包**：本地 `wallet` / `credit_ledger` 不再写入，`pay_order` 继续作为支付凭据保留；未设置 `CREDITS_APP_KEY` 时仍走旧路径（本地开发/灰度）。
6. **回滚**：移除 `CREDITS_APP_KEY` 会退回本地 `wallet`，但本地余额是切换前快照；切换后的消费不会回写，回滚前必须重新对账。

## 9. 安全与运营

- 退款页面使用账号中心 OIDC 会话；EchoMind 只链接，不代理用户退款操作。
- 应用扣减/入账必须服务端签名/应用 key；不能信任浏览器传来的 `userId`。
- 退款申请同源校验；一账号一笔由唯一部分索引兜底。
- 管理员审核需要 admin 角色或 `CREDITS_ADMIN_TOKEN`；审核、退款号、金额、操作人留痕。
- 每日对账 `credit_lot.remaining`、`credit_ledger`、支付宝退款记录；差异告警。
- 客服邮箱：`support@ljhsu.xin`，由 Cloudflare Email Routing 转发到维护者邮箱（收信在目标邮箱查看，Cloudflare 不提供收件箱）。

## 10. 验证与待确认

已用临时 D1 + Durable Object + 模拟退款服务验证：

- 注册 → 导入两笔订单（一笔 12 个月内、一笔超过 12 个月）→ 消费幂等 → 申请退款 → 二次申请 409；
- 审核期间再消费 20，审核最终金额从 120 降到 100；
- 12 个月内订单走自动原路退款（mock），超过 12 个月订单转人工；
- 余额归零后消费 402；管理员列表能按邮箱看到申请；
- 参数严格校验：字符串 `credits`、小数、越界、缺失或 1970 年的 `paidAt` 均返回 400，且不会写入 `app_usage`；
- 幂等键带用户：两个账号使用同一个 `requestId` 时各自正常扣费，互不影响；
- 导入混合批次时返回 `duplicates` / `skipped` 明细；
- EchoMind 账号中心客户端：余额读取、扣费幂等、402、充值入账、账号中心不可用时 fail closed（503）；
- 迁移脚本：FIFO 对账、差额中止（exit 2）、`--apply` 后余额与预期一致。

2026-10-28 生产切换：EchoMind 设置 `CREDITS_APP_KEY`，导入 2 笔订单（1 个账号，200 积分）；账号中心余额、台账与本地钱包对账一致。

待确认：

1. 客服邮箱具体地址（政策第 5 条）。
2. EchoMind 钱包切换与存量导入的时间窗口/回滚方案。
3. 原路退款是否最终迁到账号中心自己的支付宝商户号（当前借 EchoMind 的商户退款接口）。
4. 退款审核 SLA 与结算宽限期（建议覆盖计费延迟窗口）。
5. 是否需要支持部分退款/多订单合并退款（当前为“全部可退未消耗付费积分”）。
