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

浏览器下载静态前端和约 160 MB 的中文 Zipformer 模型，使用 AudioWorklet、Web Worker 与 WASM 在本机录音、转写。练习历史、语义稿和报告留在该浏览器的 localStorage；模型地址、ID 也存本地。API Key 和发送同意状态在当前标签页的 sessionStorage。

用户同意并配置自备模型后，前端向同源 /api/model 发送出题或评价所需的文字以及当次 API Key。Cloudflare Worker 或本机服务再转发给用户选定的模型提供商。云端没有预置大模型和统一 API Key；音频不会发给提供商。/api/model 响应为 no-store。R2 模型文件响应设置了 1 天的 Cache-Control；Worker 代码没有显式使用 Cache API，边缘是否命中缓存需在线验证。

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

## 统一账号（可选）

站点接入 LoginSuxin 的 OIDC 服务（Issuer `https://login.ljhsu.xin/api/auth`），登录完全可选，不影响本地练习。

| 项目 | 值 |
| --- | --- |
| 客户端 | EchoMind（client_id 只存在 Worker secret 中） |
| 回调 | `https://echomind.ljhsu.xin/auth/callback` |
| 登出后跳转 | `https://echomind.ljhsu.xin/` |
| 相关路由 | `/auth/login`、`/auth/callback`、`/auth/logout`、`/api/me`（均先经 Worker） |
| 会话 | `echomind_account` 签名 Cookie（HttpOnly、SameSite=Lax、30 天），只含 sub/昵称/邮箱 |

需要的 Worker secrets：`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_ISSUER`、`SESSION_SECRET`。缺少任意一个时登录入口不显示、`/auth/login` 返回 503，本地 `vite preview` 同样没有这些路由。

实现文件是 `worker/auth.ts`（PKCE、state、HMAC 签名 Cookie、token 交换与 id_token 校验），前端只调用 `/api/me` 读取登录态。退出登录会清除本站 Cookie，再跳到 IdP 的 `end-session`，该页目前是 Better Auth 自带的英文确认页。若要改文案或换成自定义页面，需要在 LoginSuxin 侧调整。

核对方式：未登录打开首页 → 右上角“登录” → 统一登录页登录/授权 → 回到 `/?auth_ok=1` 且显示昵称 → `curl https://echomind.ljhsu.xin/api/me` 返回 sub/name/email → 退出后 Cookie 清除、`/api/me` 返回 `{"user":null}`。

## 积分与支付（沙箱）

支付走支付宝 AI 网页应用收款，代码在 `worker/alipay.ts`，路由在 `worker/index.ts`：

| 路由 | 作用 |
| --- | --- |
| `POST /api/pay/create` | 登录后创建订单，返回支付宝页面跳转表单 |
| `GET /api/pay/balance` | 当前用户积分余额 |
| `POST /api/pay/notify` | 异步通知：验签、幂等入账、返回纯文本 `success` |
| `GET /api/pay/return` | 同步回跳：验签后查询交易，成功才入账 |
| `POST /api/pay/admin/{query,close,refund,refund-query}` | 需要 `x-pay-admin` 请求头，值为 `PAY_ADMIN_TOKEN` |

数据在 D1 `echomind-credits`（绑定 `DB`），表为 `wallet`、`pay_order`、`credit_ledger`、`pay_notify`，迁移文件 `migrations/0001_pay.sql`。Worker secrets 需要 `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY`、`PAY_ADMIN_TOKEN`；当前部署的是匿名沙箱应用，不能收真实款项。沙箱配置在项目根的 `.alipay-sandbox.json`，已加入 `.gitignore`，禁止提交或对外分享。

验签要点：请求签名包含 `sign_type`，异步通知/同步回跳验签排除 `sign` 与 `sign_type`；异步通知必须幂等，只有首次把订单置为 `paid` 时才增加积分。正式上线前替换为生产应用密钥、补完签约与服务开通，并把沙箱体验包下架。

## macOS 发布包

在目标架构的 macOS 上准备本地模型并运行：

~~~bash
pnpm install --frozen-lockfile
pnpm build
pnpm package:macos
~~~

脚本把当前 dist/、本机 Node 可执行文件、模型服务和启动脚本打包进 release/EchoMind-<版本>-macos-<架构>.zip。打包脚本**不会自动重新构建**；它在复制前校验 dist/index.html 与四个模型文件存在且非空，缺失时直接报错且不产出 zip，因此务必先运行 pnpm build。包的架构来自打包机，现有 v0.1.1 文档对应 x64；Apple Silicon 运行该包需 Rosetta 2。制作新 Release 时，先验证解压启动和麦克风权限，再更新 docs/releases/、CHANGELOG.md、README 下载链接与 SHA-256。

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

- 没有云端账号或跨设备同步；浏览器数据清除、换浏览器或换设备会失去本机练习历史。
- 目标 macOS Chrome 的连续 20 分钟稳定性验证尚未完成。
- 六段录音的探索性比较不足以支持普遍的 ASR 准确率或语气词识别声明。
- 线上域名、部署状态、GitHub Release 附件及 Cloudflare 控制台配置需由有权限的维护者在可访问网络中再次核验。
