# AGENTS.md

> EchoMind 代码代理工作说明。产品介绍见 README.md；部署与接手步骤见 docs/HANDOFF.md。

## 项目与目录

EchoMind 是面向 macOS 浏览器的中文表达练习应用，包含模拟面试、工作汇报、浏览器内录音和本地 ASR、可编辑语义稿及报告。前端为 React 19、TypeScript、Vite 6、Tailwind CSS 4；云端使用 Cloudflare Worker Static Assets 和 R2，另有自带 Node.js 的 macOS 本地发布包。

| 路径 | 职责 |
| --- | --- |
| src/App.tsx、src/types.ts、src/logic.ts | 练习流程、状态类型、评分与离线规则 |
| src/useRecorder.ts、src/asr.worker.ts、public/audio-processor.js | 麦克风采集和浏览器内语音识别 |
| src/SemanticEditor.tsx、src/ErrorBoundary.tsx | 防抖语义稿编辑器与渲染错误兜底 |
| src/ai.ts | 出题、评价、整场分析与模型接口调用 |
| src/modelProtocol.ts | 请求体校验、接口地址与错误信息的共享实现（本地与云端代理共用） |
| src/account.ts、src/sync.ts、src/credits.ts | 登录态、练习历史跨设备同步与积分/用量读取 |
| server/modelRoute.ts | 本地预览和 macOS 发布包的模型代理 |
| worker/index.ts、wrangler.jsonc | 云端路由：模型代理、R2 文件、账号、同步、积分与支付、静态资源 |
| worker/auth.ts、worker/sync.ts、worker/platform.ts、worker/accountCredits.ts、worker/alipay.ts、migrations/ | OIDC 登录、D1 练习同步、平台模型计费与账号中心客户端、支付宝收款 |
| scripts/prepare-model.mjs、scripts/clean-cloudflare-assets.mjs | 本地模型准备与云端构建清理 |
| scripts/import-credits.mjs | 把本地钱包/订单按 FIFO 迁移到账号中心（默认 dry-run） |
| scripts/package-macos.mjs、scripts/release-server.ts | macOS 发布包及本机服务 |

## 开发与验证

使用 pnpm 和 pnpm-lock.yaml；package-lock.json 是被忽略的本地遗留文件。开始前运行 git status --short，保留已有改动。

~~~bash
pnpm install --frozen-lockfile
pnpm dev                 # 先构建，再预览于 http://127.0.0.1:4174/
pnpm build               # 准备语音模型 + TypeScript 检查 + Vite 构建
pnpm build:cloudflare    # 构建并移除 dist/models
pnpm exec wrangler deploy --dry-run
pnpm package:macos       # macOS 上先 pnpm build；产物在 release/
~~~

pnpm dev 不是 Vite 热更新服务；改完代码须重启。当前 ASR WASM 在热更新模式下不能正确定位 asr.wasm。仓库目前没有 test 或 lint 脚本；不要把它们写成已通过的验证项。修改代码至少运行受影响的构建，并对录音、转写、模型代理等行为做相应的实际检查。

`pnpm build` 的第一条命令是 scripts/prepare-model.mjs，模型准备是构建的一部分（仓库不使用 npm 的 prebuild 钩子，因为 pnpm 默认不执行）。tsconfig.json 的 include 覆盖 src、worker、server 与 scripts/**/*.ts，改动代理或发布脚本也会进入类型检查。

## 必须保持的行为

- 音频在浏览器内处理，不把音频发给任何服务，也不把原始转写发给模型提供商。原始转写与可修订语义稿分开；分析只使用语义稿，评分证据必须来自其中的连续原文。语气词、重复和停顿是参考指标，不参与内容评分。
- 练习历史：登录后同步到 D1 `practice_sessions`（含原始转写、语义稿、评分和报告，不含音频），这是用户可见的隐私行为，改动时必须同步更新 README、HANDOFF 和界面文案。升级前遗留的匿名历史保存在 localStorage 的 `echomind-history-v2:anonymous`，登录后通过侧栏“导入本机练习”导入；新流程不再产生匿名练习。同步以服务端接收时间为 LWW、只推内容变化的练习、按 UTF-8 字节限制（客户端单条 1.9MB/单批 7MB）；改动游标或冲突规则时保持跨设备一致性。API Key 与发送同意状态使用当前标签页 sessionStorage。改动存储或请求内容时同步检查隐私说明和旧数据兼容性。
- 默认主题（翡翠）的 HeroUI 风格打磨集中在 src/ui.css，规则限定在 :root[data-theme="emerald"]；改样式时不要影响报纸风、粗犷风等其他主题。
- 统一登录（LoginSuxin OIDC）是开始练习的前提：`worker/auth.ts` 用 PKCE + 签名 Cookie 只保存 sub、昵称和邮箱；练习内容不放在 Cookie 里，登录后 `worker/sync.ts` 会把练习历史写入 D1（不含音频）。Issuer 是 `https://account.ljhsu.xin/api/auth`（旧 `login` 308）；账号中心同时负责账号积分与退款。未登录时 `startNew` / `createSession` / 继续未完成练习都会跳转 `/auth/login`；缺少 `OIDC_*` 或 `SESSION_SECRET` 时登录入口必须隐藏、退回本地练习（仅本地预览/故障兜底）；改动认证流程时同步更新 HANDOFF 的核对步骤。
- 前端只调用同源 /api/model。本地实现与云端实现分别在 server/modelRoute.ts 和 worker/index.ts；改动协议、校验、超时或错误处理时检查两条路径。云端只接受公开 HTTPS 提供商域名，本地允许 localhost；不要把用户 API Key 写入构建产物、日志或部署密钥。限流一律由 D1 固定窗口计数保证（`worker/rateLimit.ts` + `rate_limit` 表）：`/api/model` 每 IP 30 次/60 秒，`/api/platform-model` 每账号 20 次/60 秒，均在读取请求体/扣费之前拦截；isolate 内 `createRateLimiter` 只做便宜的预筛。Cloudflare Rate Limiting 绑定在本账号生产环境实测不生效（连续/并发请求全部放行），配置已移除，不要再加回来。计数表由每小时 Cron（`triggers.crons`）清理一天前的窗口，`platform_request` 过期缓存也由它清理，单次最多 2000 行。修改限流策略时同步 `worker/index.ts`、`worker/platform.ts`、`worker/index.ts` 的 `scheduled` 和 HANDOFF。
- 平台模型计费：同一 `requestId` 的重试必须返回 `platform_request` 缓存且不重复扣费。设置 `CREDITS_APP_KEY` 后进入账号积分模式：余额/扣费/充值入账调账号中心 `worker/accountCredits.ts`（扣费幂等键为 `sha256(sub:requestId)`），扣费成功后才能在本地写 `model_usage` 与响应缓存；账号中心不可用时必须 fail closed（503），不能返回未结算的模型结果。未设置时保持旧的本地 `wallet` batch 路径（扣余额、写台账、写用量、写缓存同一 batch，用 `changes()` 门控）。新增或修改相关表时更新 `migrations/`、HANDOFF 的迁移步骤和隐私说明。
- 积分的目标归属是**账号**（OIDC `sub`），不是单个应用；账号中心统一钱包、充值入账、消费台账与退款。EchoMind 已切换为账号积分模式（`CREDITS_APP_KEY`），本地 `wallet` / `credit_ledger` 只作为归档与回滚路径，不再写入；充值仍由 EchoMind 的支付宝商户号收款后调账号中心 `credit` 入账。充值入口：套餐 ¥1/100、¥10/1000、¥50/5000，或按积分自定义 50～1,000,000（1 积分 = ¥0.01，价格由服务端按积分重算 `customPackage`）；外部可用 `/?recharge=<积分>` 直接打开充值并预填额度（未登录先去登录再回跳）。设计与迁移见 `docs/account-credits.md`，退款规则见 `docs/refund-policy.md`（含“处理中申请超过 14 天自动失效”与“`failed` 可重试失败项”）。切换前/回滚时不要对外宣称“跨平台通用积分”的文案。
- 四个 ASR 文件名固定为 encoder.onnx、decoder.onnx、joiner.onnx、tokens.txt。本地从 benchmarks/private/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30/ 准备到 public/models/zipformer-2025/；云端从 R2 桶 app 的 echomind/ 前缀读取。模型文件和私人录音不入 Git。pnpm build:cloudflare 会从静态产物移除模型。
- wrangler.jsonc 的 Worker 名为 echomind，R2 绑定为 MODELS；普通 wrangler deploy 指向当前 Wrangler 登录的账号，执行前核对账号和目标。模型文件响应声明可缓存 1 天；替换同名对象后须检查实际缓存或改用新文件名。具体步骤见 docs/HANDOFF.md。
- package:macos 复制已有 dist/，不会自动构建。先完成包含模型文件的 pnpm build，再打包；脚本会在复制前校验 dist/index.html 与四个模型文件存在且非空，缺失时直接报错且不产出 zip。产物架构由打包机决定。目前文档中的 v0.1.1 包是 macOS x64，Apple Silicon 运行需 Rosetta 2。
- 录音缓冲上限为 20 分钟（src/asr.worker.ts 的 MAX_BUFFER_SECONDS），超出部分不再保留并在界面上提示；「重新转写」使用的是这个缓冲，确认回答后立即释放。收尾转写有 15 秒超时兜底，避免界面永久停在收尾状态。
- 账号登录与跨设备同步已上线（开始练习前必须登录；未配置 OIDC 时退回本地练习），Windows 适配尚未完成；目标 macOS Chrome 的连续 20 分钟稳定性测试仍待完成。六段录音不能支持普遍的识别准确率声明。

## 交付前核对

1. 运行 git status --short，确认没有覆盖或顺带提交已有改动及私有材料。
2. 运行 pnpm build；若修改 Cloudflare 交付，再运行 pnpm build:cloudflare 和 pnpm exec wrangler deploy --dry-run。
3. 按改动范围实际检查首页、/changelog、模型文件加载、录音与转写、模型连接及报告。构建成功不代表麦克风、WASM、R2 和提供商请求都正常。
4. 汇报修改文件、运行的命令与结果，以及尚未验证的事项。功能或部署流程变化时同步更新 README.md 与 docs/HANDOFF.md。
