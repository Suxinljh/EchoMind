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
| server/modelRoute.ts | 本地预览和 macOS 发布包的模型代理 |
| worker/index.ts、wrangler.jsonc | 云端模型代理、R2 文件路由与静态资源 |
| scripts/prepare-model.mjs、scripts/clean-cloudflare-assets.mjs | 本地模型准备与云端构建清理 |
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

- 音频在浏览器内处理，不把音频或原始转写发给模型提供商。原始转写与可修订语义稿分开；分析只使用语义稿，评分证据必须来自其中的连续原文。语气词、重复和停顿是参考指标，不参与内容评分。
- 练习历史、模型地址和模型 ID 使用浏览器 localStorage；API Key 与发送同意状态使用当前标签页 sessionStorage。改动存储或请求内容时同步检查隐私说明和旧数据兼容性。
- 统一登录（LoginSuxin OIDC）是可选的：`worker/auth.ts` 用 PKCE + 签名 Cookie 只保存 sub、昵称和邮箱，不建立数据库，也不上传练习内容。缺少 `OIDC_*` 或 `SESSION_SECRET` 时登录入口必须隐藏、本地练习不受影响；改动认证流程时同步更新 HANDOFF 的核对步骤。
- 前端只调用同源 /api/model。本地实现与云端实现分别在 server/modelRoute.ts 和 worker/index.ts；改动协议、校验、超时或错误处理时检查两条路径。云端只接受公开 HTTPS 提供商域名，本地允许 localhost；不要把用户 API Key 写入构建产物、日志或部署密钥。
- 四个 ASR 文件名固定为 encoder.onnx、decoder.onnx、joiner.onnx、tokens.txt。本地从 benchmarks/private/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30/ 准备到 public/models/zipformer-2025/；云端从 R2 桶 app 的 echomind/ 前缀读取。模型文件和私人录音不入 Git。pnpm build:cloudflare 会从静态产物移除模型。
- wrangler.jsonc 的 Worker 名为 echomind，R2 绑定为 MODELS；普通 wrangler deploy 指向当前 Wrangler 登录的账号，执行前核对账号和目标。模型文件响应声明可缓存 1 天；替换同名对象后须检查实际缓存或改用新文件名。具体步骤见 docs/HANDOFF.md。
- package:macos 复制已有 dist/，不会自动构建。先完成包含模型文件的 pnpm build，再打包；脚本会在复制前校验 dist/index.html 与四个模型文件存在且非空，缺失时直接报错且不产出 zip。产物架构由打包机决定。目前文档中的 v0.1.1 包是 macOS x64，Apple Silicon 运行需 Rosetta 2。
- 录音缓冲上限为 20 分钟（src/asr.worker.ts 的 MAX_BUFFER_SECONDS），超出部分不再保留并在界面上提示；「重新转写」使用的是这个缓冲，确认回答后立即释放。收尾转写有 15 秒超时兜底，避免界面永久停在收尾状态。
- 尚无云端账号、同步或 Windows 适配；目标 macOS Chrome 的连续 20 分钟稳定性测试仍待完成。六段录音不能支持普遍的识别准确率声明。

## 交付前核对

1. 运行 git status --short，确认没有覆盖或顺带提交已有改动及私有材料。
2. 运行 pnpm build；若修改 Cloudflare 交付，再运行 pnpm build:cloudflare 和 pnpm exec wrangler deploy --dry-run。
3. 按改动范围实际检查首页、/changelog、模型文件加载、录音与转写、模型连接及报告。构建成功不代表麦克风、WASM、R2 和提供商请求都正常。
4. 汇报修改文件、运行的命令与结果，以及尚未验证的事项。功能或部署流程变化时同步更新 README.md 与 docs/HANDOFF.md。
