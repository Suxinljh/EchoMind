# EchoMind 项目交接

更新于 2026-10-27。本文依据当前仓库代码与配置整理；线上状态以 Cloudflare 控制台和实际访问结果为准。

## 现在交付在哪里

| 交付形式 | 仓库可确认的信息 | 接手时需核实 |
| --- | --- | --- |
| 网站 | README.md 使用 https://echomind.ljhsu.xin/ 作为线上地址。wrangler.jsonc 配置名为 echomind 的 Cloudflare Worker，前端走 Workers Static Assets，/api/* 与 /models/* 先由 Worker 处理。 | 当前域名是否仍指向该 Worker、最近一次成功部署、Cloudflare 账号及域名路由。仓库没有域名路由或账号 ID 配置。 |
| 语音模型 | Worker 从 R2 桶 app 的 echomind/ 前缀读取四个模型文件，公开访问路径是 /models/zipformer-2025/<文件名>。 | 目标账号中的 R2 对象是否完整、缓存命中及文件版本。 |
| macOS 包 | README.md 指向 GitHub Releases；当前版本 v0.1.1 的发布说明在 docs/releases/v0.1.1.md，文件名为 EchoMind-0.1.1-macos-x64.zip（v0.1.0 说明保留在 docs/releases/v0.1.0.md）。 | Releases 页面上的附件、下载可用性和 SHA-256；仓库内 release/ 被忽略。 |

本次交接编写时，访问线上域名出现 TLS 连接错误，Wrangler 的部署列表查询因网络请求失败；因此**无法确认目前线上是否可用、部署版本或绑定账号**。上述域名和部署方式是仓库记录，不能当作实时在线证明。

## 架构与数据流

浏览器下载静态前端和约 160 MB 的中文 Zipformer 模型，使用 AudioWorklet、Web Worker 与 WASM 在本机录音、转写。开始练习前需要登录 Suxin 账号；练习历史会同步到 D1 `practice_sessions`（含原始转写、语义稿、评分和报告，不含音频），本机同时保留缓存。升级前未登录时保存在浏览器的练习仍保留，登录后可导入。模型地址、ID 存本地；API Key 和发送同意状态在当前标签页的 sessionStorage。

用户同意并配置自备模型后，前端向同源 /api/model 发送出题或评价所需的文字以及当次 API Key。Cloudflare Worker 或本机服务再转发给用户选定的模型提供商。自备模型路径没有预置大模型和统一 API Key；平台模型路径使用服务端 `PLATFORM_API_KEY`，按 token 计费并从积分余额扣减。音频不会发给任何服务；/api/model 响应为 no-store。云端 /api/model 的限额由 D1 固定窗口计数保证（`rate_limit` 表，每 IP 30 次/60 秒），isolate 内存限流只做预筛；本地预览与 macOS 包为 60 次/分钟。R2 模型文件响应设置了 1 天的 Cache-Control；Worker 代码没有显式使用 Cache API，边缘是否命中缓存需在线验证。

## 接手先确认

1. 取得目标 Cloudflare 账号对 Workers、R2、DNS/路由及 Workers Builds 的管理权限；取得 GitHub 仓库和 Releases 权限。仓库不记录账号 ID、部署流水线的真实启用状态或任何密钥。
2. 在正确账号中核对 Worker echomind、域名 echomind.ljhsu.xin、R2 桶 app、绑定名 MODELS、Builds 连接仓库及生产分支 main。不要凭本机 Wrangler 登录状态猜账号。
3. 查看最近部署的提交 SHA、时间和状态，确认与仓库 main 对应。Cloudflare Builds 若启用，仓库建议的构建命令是 pnpm build:cloudflare，部署命令是 pnpm exec wrangler deploy；这只是仓库中的配置说明，需在控制台核对实际设置。
4. 从能访问域名的网络分别检查 /、/changelog、四个 /models/zipformer-2025/* 文件，以及浏览器里的麦克风、模型加载与连接测试。不要把 POST /api/model 的真实 API Key 留在终端历史或共享日志里。

## 本地开发

要求 Node.js、pnpm 和四个 ASR 模型文件。以 pnpm-lock.yaml 安装依赖：

~~~bash
pnpm install --frozen-lockfile
~~~

从 [sherpa-onnx 模型列表](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) 获取 sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30。把 encoder.int8.onnx、decoder.onnx、joiner.int8.onnx、tokens.txt 放在 benchmarks/private/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30/；构建时会复制到 public/models/zipformer-2025/ 并将两个 .int8.onnx 改名。也可直接在 public/models/zipformer-2025/ 放置最终文件名的四个文件。它们都不进入 Git。

~~~bash
pnpm dev       # 构建后预览：http://127.0.0.1:4174/
pnpm build     # 准备语音模型 + TypeScript 检查 + 前端构建
~~~

pnpm dev 每次启动只构建一次，改代码后重启。当前 ASR WASM 在 Vite 热更新模式下找不到 asr.wasm，因此脚本使用 vite preview。仓库没有自动化 test 或 lint 命令。

`pnpm build` 的第一条命令就是 scripts/prepare-model.mjs，所以全新克隆后直接构建也会准备模型；仓库不再使用 npm 的 prebuild 钩子（pnpm 默认不执行 pre/post 脚本）。缺少模型时构建会以明确错误中止。tsconfig.json 的 include 覆盖 src、worker、server 与 scripts/**/*.ts，因此改动模型代理或发布脚本同样会进入类型检查。

## Cloudflare 部署

部署脚本和参数的权威来源是 package.json、wrangler.jsonc、worker/index.ts。先核对 Wrangler 登录账号和目标桶，再执行上传；**上传对象和部署都会修改线上状态**。

~~~bash
pnpm exec wrangler whoami
# 应用 migrations/ 下的 D1 迁移（含 platform_request 缓存表）；本地开发用 --local
pnpm exec wrangler d1 migrations apply echomind-credits --remote

for name in encoder.onnx decoder.onnx joiner.onnx tokens.txt; do
  pnpm exec wrangler r2 object put "app/echomind/$name" --remote \
    --file "public/models/zipformer-2025/$name" \
    --content-type application/octet-stream
done

pnpm build:cloudflare
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler deploy
~~~

R2 模型通常只需在首次部署、换模型或丢失对象时上传。build:cloudflare 设置 ECHOMIND_CLOUDFLARE_BUILD=1，跳过本地模型准备，然后删除 dist/models；因此云端构建机器无需下载大模型，四个文件必须事先在 R2。wrangler.jsonc 未定义环境名，普通 wrangler deploy 会部署当前账号里的 echomind Worker。自动部署按仓库 README 所述使用 main、pnpm build:cloudflare 和 pnpm exec wrangler deploy，但应以控制台实际设置为准。

部署后用浏览器完整验证录音、转写与报告，并检查模型文件：

~~~bash
curl -I https://echomind.ljhsu.xin/
curl -I https://echomind.ljhsu.xin/changelog
curl -sS -o /dev/null -D - https://echomind.ljhsu.xin/models/zipformer-2025/tokens.txt
~~~

重复最后一个 GET 可观察 Cf-Cache-Status；若始终没有命中，先检查实际缓存规则，不要仅凭 Cache-Control 推断边缘已缓存。更换同名模型对象后，应检查并清理实际生效的缓存，或修改文件名及前端引用；浏览器也可能在 1 天内继续使用旧版本。

## 统一账号（开始练习前必须登录）

站点接入 LoginSuxin 的 OIDC 服务（Issuer `https://account.ljhsu.xin/api/auth`；旧 `login.ljhsu.xin` 由账号中心 308 跳转）。开始练习前必须登录：未登录时“新建练习”“开始练习”和继续未完成练习都会跳转 `/auth/login`；已完成练习的报告仍可只读查看。未配置 OIDC 时退回本地练习模式（仅本地预览/登录服务故障时兜底）。账号中心同时提供账号积分与退款页面。

| 项目 | 值 |
| --- | --- |
| 客户端 | EchoMind（client_id 只存在 Worker secret 中） |
| 回调 | `https://echomind.ljhsu.xin/auth/callback` |
| 登出后跳转 | `https://echomind.ljhsu.xin/` |
| 相关路由 | `/auth/login`、`/auth/callback`、`/auth/logout`、`/api/me`（均先经 Worker） |
| 会话 | `echomind_account` 签名 Cookie（HttpOnly、SameSite=Lax、30 天），只含 sub/昵称/邮箱；练习内容不在 Cookie 中，登录后的历史写入 D1 `practice_sessions` |

需要的 Worker secrets：`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_ISSUER`、`SESSION_SECRET`。缺少任意一个时登录入口不显示、`/auth/login` 返回 503，本地 `vite preview` 同样没有这些路由。

实现文件是 `worker/auth.ts`（PKCE、state、HMAC 签名 Cookie、token 交换与 id_token 校验），前端只调用 `/api/me` 读取登录态。退出登录会清除本站 Cookie，再跳到账号中心的 `end-session`；账号中心现在直接结束会话并 302 回本站，不再显示二次确认页。从账号中心退出后按浏览器“后退”命中 bfcache 时，EchoMind 会在 `pageshow (persisted)` 时重新请求 `/api/me`。

核对方式：未登录打开首页 → 点“新建练习”应跳转统一登录页 → 登录/授权 → 回到 `/?auth_ok=1` 且显示昵称并进入首页 → `curl https://echomind.ljhsu.xin/api/me` 返回 sub/name/email → 退出后 Cookie 清除、`/api/me` 返回 `{"user":null}`。

## 练习历史与账号隔离

练习历史在浏览器 localStorage 中按账号隔离，登录后还会同步到 D1：

- 未登录：`echomind-history-v2:anonymous`（升级前遗留，仅登录后可导入；新流程不再写入）
- 已登录：`echomind-history-v2:user:<sub>`
- 旧数据 `echomind-practice-history-v1` 会一次性复制到匿名存储，旧键保留作回退
- 首次登录且存在匿名练习时，会询问是否导入当前账号；选择“暂不导入”后侧栏会保留「导入本机练习」入口，不会丢数据
- 导入后清除匿名副本，并记录 `echomind-history-v2:migrated:<sub>`，之后不再自动询问
- 页面跳转/关闭时会把待写入的历史立即落盘，避免防抖窗口内的记录丢失
- 退出登录后会回到匿名历史；导入过的账号数据不会出现在匿名里
- 登录后自动同步，无关闭开关；D1 `practice_sessions` 以 `(user_id, session_id)` 为主键，`session_id` 使用练习的 `createdAt`
- 同步内容包含原始转写、语义稿、评分和报告，**不包含音频**；按 UTF-8 字节限制：客户端单条 ≤1.9MB、单批 ≤7MB，服务端单条 ≤1.9MB、单次 ≤8MB（D1 单行上限 2MB）
- 冲突按服务端接收时间最后写入优先；`updated_at` 由服务端赋值，客户端只推送内容变化的练习。客户端用 `echomind-sync-v1:<sub>` 记录行游标、内容哈希和服务端时间偏移，避免设备时钟偏差
- 登录、窗口重新聚焦、每 60 秒、以及本地历史变化后 1.5 秒自动同步；顶部显示同步状态，点击可手动重试

## 积分与支付

支付走支付宝 AI 网页应用收款，代码在 `worker/alipay.ts`，路由在 `worker/index.ts`：

| 路由 | 作用 |
| --- | --- |
| `POST /api/pay/create` | 登录后创建订单，返回支付宝页面跳转表单 |
| `GET /api/pay/balance` | 当前用户积分余额 |
| `POST /api/pay/notify` | 异步通知：验签、幂等入账、返回纯文本 `success` |
| `GET /api/pay/return` | 同步回跳：验签后查询交易，成功才入账 |
| `POST /api/pay/admin/{query,close,refund,refund-query}` | 需要 `x-pay-admin` 请求头，值为 `PAY_ADMIN_TOKEN` |

数据在 D1 `echomind-credits`（绑定 `DB`），表为 `wallet`、`pay_order`、`credit_ledger`、`pay_notify`、`model_usage`、`practice_sessions`、`platform_request`，迁移文件在 `migrations/`（0001–0004）。Worker secrets 需要 `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY`、`PAY_ADMIN_TOKEN`；切换账号积分模式后再加 `CREDITS_APP_KEY`（与账号中心 `APP_API_KEYS.echomind` 一致）。当前已切换为生产应用 `2021007112648879`（网关 `https://openapi.alipay.com/gateway.do`），并完成过一笔 ¥0.01 真实支付：同步回跳、交易查询、异步通知（HTTP 200）和积分入账均已验证。沙箱配置 `2021003176635074` 仅保留在本机 `.alipay-sandbox.json` 供开发测试。沙箱配置在项目根的 `.alipay-sandbox.json`，已加入 `.gitignore`，禁止提交或对外分享。生产支付宝公钥从 `~/.config/2021007112648879-alipayPublicKey.keytext` 读取后写入 Worker secret；应用私钥只由用户在 `wrangler secret put ALIPAY_PRIVATE_KEY` 时录入。

验签要点：请求签名包含 `sign_type`，异步通知/同步回跳验签排除 `sign` 与 `sign_type`；异步通知必须幂等，只有首次把订单置为 `paid` 时才增加积分。订单置 paid、写 `credit_ledger` 和加 `wallet` 余额在同一个 D1 batch（事务）中完成，并用 `changes()` 门控防止重复通知重复入账；若历史数据出现“已 paid 但台账缺失”，下一次通知会补齐。`pay_notify` 只记录验签通过的通知，未验签请求不再写库。正式上线前替换为生产应用密钥、补完签约与服务开通，并把沙箱体验包下架。

## 账号积分与退款

账号中心已在 **LoginSuxin** 仓库实现，地址 `https://account.ljhsu.xin`（旧 `login.ljhsu.xin` 308）。它统一负责账号、登录、钱包、消费台账、退款申请与审核；积分归属 OIDC `sub`，可在接入的平台通用。

- 账号中心页面：`/credits`、`/refunds`、`/terms/refund`、`/admin/refunds`。
- 并发：每个账号一个 `AccountDO`，串行化消费/退款。
- 退款：按**审核时**计算 12 个月与最终金额；一个账号同一时间一笔处理中退款（超过 14 天未审核自动失效，可重新提交）；超过 12 个月的支付宝订单转人工。部分订单失败时申请标记 `failed`，可对同一申请重试，已退款/转人工项不会重复处理。
- 原路退款：当前通过 EchoMind 的支付宝商户退款接口（`ECHOMIND_REFUND_URL` + `ECHOMIND_PAY_ADMIN_TOKEN`）。
- 详细数据模型、API、算法和迁移步骤见 [`account-credits.md`](./account-credits.md)；规则文案见 [`refund-policy.md`](./refund-policy.md)。

### 积分迁移与回滚

存量导入脚本是 `scripts/import-credits.mjs`。它读取 EchoMind D1 的 `pay_order` 与 `credit_ledger`，按 FIFO 计算每笔订单的剩余积分，默认只读预演并与本地 `wallet` 对账，`--apply` 才调用账号中心导入接口。

切换顺序（不要在本地钱包仍可消费时导入）：

1. 部署本版 Worker（未设置 `CREDITS_APP_KEY`，行为不变）。
2. 设置 `CREDITS_APP_KEY`，立即进入账号积分模式；等待约 1 分钟让在途平台请求结束。
3. `node scripts/import-credits.mjs --remote` 预演，确认“应导入 = 本地钱包”且差额为 0。
4. `node scripts/import-credits.mjs --remote --apply --admin-token <CREDITS_ADMIN_TOKEN>`；脚本会核对账号中心余额。

回滚：移除 `CREDITS_APP_KEY` secret 会退回本地 `wallet`，但本地余额停留在切换前快照，切换后产生的消费不会回写。切换后如需回滚，必须先重新对账，不能只删 secret。

**2026-10-28 生产切换完成**：EchoMind 已设置 `CREDITS_APP_KEY`，`0004_platform_request` 已应用到远程 D1；导入 2 笔已支付订单（1 个账号，200 积分），账号中心余额与本地钱包一致。本地 `wallet` 保留 200 作为归档，不再读写。同一天随后应用了 `0005_platform_rate`、`0006_rate_limit`（限流计数表，`platform_rate` 已并入 `rate_limit`）。

**退款通道已配置**：账号中心与 EchoMind 两端都已设置 `ECHOMIND_PAY_ADMIN_TOKEN` / `PAY_ADMIN_TOKEN`（值相同），审核通过会自动调支付宝原路退款。2026-10-28 已用一笔 ¥1.00 订单做过真实端到端验证（管理员审核 → 原路退回成功）；后续改动退款链路时仍建议用小额订单复跑一次并在支付宝商家后台核对退款单号与金额。

**原路退款超时**：账号中心调用 EchoMind 退款接口设了 10 秒超时；超时视为“结果未知”，明细标记 `failed` 并提示先到支付宝后台核对，不要直接重复点“重试失败项”，否则可能重复退款。

**申请失效**：`pending` 申请超过 14 天未审核会自动失效（用户可重新提交），避免一笔无人审核的申请把账号锁死。

**EchoMind 已切换为账号积分模式**：设置 `CREDITS_APP_KEY` 后，平台模型的余额、扣费与充值入账都由账号中心负责，本地 `wallet` / `credit_ledger` 停止读写（保留归档与回滚）。积分归属 OIDC `sub`，可在接入的应用间通用；充值仍在 EchoMind 的模型设置里用支付宝完成，退款在账号中心发起。OIDC issuer 为 `https://account.ljhsu.xin/api/auth`。

## 平台模型与积分计量

平台模型网关在 `worker/platform.ts`，路由 `/api/platform-model`；积分查询 `/api/credits`，用量日志 `/api/credits/usage`。

- 计费按 token：`成本 = 输入token/1M × 输入单价 + 输出token/1M × 输出单价`，扣费为成本的 **`PLATFORM_MARKUP` 倍**（当前 5 倍，工具提示按一次 5 题约 30～50 积分展示）；1 积分 = ¥0.01。
- 单价由 vars 配置：`PLATFORM_INPUT_COST_PER_M`（默认 2）、`PLATFORM_OUTPUT_COST_PER_M`（默认 8），单位是元/百万 token；供应商 Key 用 secret `PLATFORM_API_KEY`，模型用 `PLATFORM_MODEL_BASE_URL` / `PLATFORM_MODEL_ID`。
- 输出上限：出题 1200、逐题评价 1400、整场分析 900、连接测试 16。自有模型路径也会带上对应的 `max_tokens`。
- 账号积分模式（设置了 `CREDITS_APP_KEY`）：余额读取、扣费、充值入账都调 `https://account.ljhsu.xin`（`CREDITS_API_URL` / `CREDITS_APP_ID` 在 vars）。扣费在返回模型结果之前完成，账号中心不可用时返回 503 而不是白给结果；扣费幂等键为 `sha256(sub:requestId)`，避免跨用户碰撞和超长。本地只写 `model_usage` 保存 token/模型明细，不再写 `wallet` 和 `credit_ledger`。
- 未设置 `CREDITS_APP_KEY` 时保持旧路径：扣余额、写台账、写用量在同一个 D1 batch 中完成，余额不足时不会扣成负数。余额在顶部「积分」按钮中查看，点击可看最近 20 条真实 token 用量。
- 平台模型上游请求 60 秒超时，并监听客户端断开后中止上游，避免客户端放弃后仍继续生成/计费。
- `/api/platform-model` 按账号限流 20 次/60 秒：计数在 D1 表 `rate_limit`（scope=`platform`，窗口对齐 60 秒），在扣费与上游调用之前拦截，超限返回 429 + `Retry-After`；按 IP 只保留 isolate 内存预筛。
- **Cloudflare Rate Limiting 绑定在本账号不生效**：曾配置 `MODEL_RATE_LIMITER` / `PLATFORM_RATE_LIMITER`，部署后各发 36/40 个请求全部放行（本地 `wrangler dev` 能正常限流），现已移除绑定配置，限额全部改用 D1 计数（线上验证：`/api/model` 第 31 个请求起 429）。
- **每小时 Cron**（`wrangler.jsonc` 的 `triggers.crons` = `17 * * * *`）清理 `platform_request` 过期缓存与一天前的 `rate_limit` 窗口，单次最多 2000 行；请求路径里仍保留一个同口径的 200 行兜底清理。
- 客户端为每次平台调用生成 `requestId`；网络错误时自动重试一次并复用同一 ID。服务端在 `platform_request` 表缓存已完成的结果（1 小时），同一 ID 的重试直接返回缓存、不重复调用上游、不重复扣费；过期缓存每次请求最多清理 200 行（`created_at` 有索引），不会随表体积变慢。
- 当前充值套餐：¥1/100 积分、¥10/1000、¥50/5000，另可按积分自定义额度（50～1,000,000 积分，1 积分 = ¥0.01）。金额一律由服务端按积分重算（`customPackage`），不信任客户端传来的价格；账号中心 `/credits` 的充值入口跳转到 `https://echomind.ljhsu.xin/?recharge=<积分>`。充值仍由 EchoMind 的支付宝商户号收款，支付成功后调账号中心 `credit` 入账；退款由账号中心发起，`ECHOMIND_PAY_ADMIN_TOKEN`（与 EchoMind `PAY_ADMIN_TOKEN` 一致）已配置并通过 ¥1.00 小额订单验证过原路退回。

## macOS 发布包

在目标架构的 macOS 上准备本地模型并运行：

~~~bash
pnpm install --frozen-lockfile
pnpm build
pnpm package:macos
~~~

脚本把当前 dist/、本机 Node 可执行文件、模型服务和启动脚本打包进 release/EchoMind-<版本>-macos-<架构>.zip。打包脚本**不会自动重新构建**；它在复制前校验 dist/index.html 与四个模型文件存在且非空，缺失时直接报错且不产出 zip，因此务必先运行 pnpm build。包的架构来自打包机，现有 v0.1.1 文档对应 x64；Apple Silicon 运行该包需 Rosetta 2。制作新 Release 时，先验证解压启动和麦克风权限，再更新 docs/releases/、CHANGELOG.md、README 下载链接与 SHA-256。

本机服务默认监听固定端口 `4174`（可用 `ECHOMIND_PORT` 覆盖），这样 localStorage 在多次启动间保持同一 origin；端口被占用时会回退随机端口并在终端提示，本次数据不会在下次启动保留。旧版本使用随机端口，旧数据不会自动迁移到新端口。

## 常见坑与排查

| 现象 | 优先检查 |
| --- | --- |
| 本地构建提示缺少模型 | 私有源目录的四个文件是否齐全，或 public/models/zipformer-2025/ 是否已有最终文件名；prepare-model 只复制缺失文件，不覆盖旧文件。 |
| 打包提示「dist 中缺少有效文件」 | 说明 dist 里没有页面或四个模型（常见于上次跑的是 build:cloudflare，它删掉了 dist/models）。重新运行 pnpm build 后再打包。 |
| 收尾转写一直停在“正在收尾转写…” | 15 秒后会自动给出已有结果并说明原因；若反复出现，检查浏览器控制台里语音模型（WASM）的加载错误。 |
| 云端页面正常但转写加载失败 | R2 app/echomind/ 四个对象、MODELS 绑定、/models/* Worker 优先路由及网络请求状态；build:cloudflare 刻意不上传静态模型。 |
| 修改代码后本地仍是旧界面 | pnpm dev 使用预览服务，重启命令重新构建。 |
| 云端自备模型连接失败 | 提供商地址须为公开 HTTPS 域名；localhost 只适用于本地服务。核对同意状态、模型 ID、提供商余额及其服务状态。 |
| 模型文件已更新但浏览器取到旧版本 | R2 对象、浏览器/边缘 1 天缓存及 Cf-Cache-Status；清缓存或改文件名。 |
| 麦克风计时正常但没有文字 | 在设备设置检查实际麦克风与输入电平；有电平时先用“重新转写已录音频”，再尝试换设备。 |
| Git 未看到模型、私有录音或发布包 | public/models/、benchmarks/private/、release/ 被 .gitignore 排除，需按上面的流程单独准备。 |
| 网站和下载包行为不一致 | 云端代理在 worker/index.ts，本机代理在 server/modelRoute.ts；修改其中一处时要核对另一处。 |

## 已知边界

- 账号与跨设备同步已实现：开始练习前必须登录，练习历史写入 D1（不含音频），没有单独的同步开关，退出登录后停止同步。拉取使用 `(updated_at, session_id)` 行游标并支持分页，避免读副本延迟或 `serverTime` 游标导致永久漏拉；客户端只推送内容变化的练习，并按 ≤200 条/≤7MB 分批，服务端单次仍限制 200 条/8MB。
- 目标 macOS Chrome 的连续 20 分钟稳定性验证尚未完成。
- 六段录音的探索性比较不足以支持普遍的 ASR 准确率或语气词识别声明。
- 线上域名、部署状态、GitHub Release 附件及 Cloudflare 控制台配置需由有权限的维护者在可访问网络中再次核验。
