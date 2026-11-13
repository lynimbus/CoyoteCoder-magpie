# CLAUDE.md

这份文件给在这个仓库里干活的 agent 看。

## 这是什么

CoyoteCoder 现在是一个 **magpie 插件**（npm 包形状的文件夹），不是独立的代理/桌面程序。

magpie 自己就是 agent 请求的网关；本插件用 magpie 的网关钩子旁听每次请求，把“请求开始 / 生成中 / 完成 / 工具调用 / 报错”变成 DG-LAB 郊狼的输出，另外带一个控制面板页面。

用户是业余开发者，做 vibe coding：解释要短、要实用，别一上来讲协议细节。用户可见文档用中文。

## 常用命令

```bash
npm install
npm run typecheck          # tsc --noEmit（strict）
npm test                   # vitest run
npx vitest run src/host/runtime.test.ts   # 单个文件
```

没有构建步骤：magpie 的宿主是 Bun，直接跑 TypeScript（`main` 和 `magpie.hooks` 都指向 `.ts`）。要试装：

```bash
magpie plugin add ./             # 本地文件夹
magpie plugin options coyotecoder '{"port":8787}'
```

## 结构

- `index.ts` — `main`。宿主入口，建运行时（DG-LAB 链路 + 内置中继 + 控制面板服务），返回空 hooks。
- `hooks.ts` — `magpie.hooks`。`onRequest` / `onResponse` → 事件。必须快且不抛异常（抛了就收不到配对的 `onResponse`）。
- `page/` — `magpie.page`：带路页，把自己导航到面板服务。
- `console/` — 面板本体（原生 HTML/CSS/JS，无构建），由插件自己的 HTTP 服务提供。
- `src/host/runtime.ts` — 组装根：bus / policy / engine / safety / sink / controller / relay，外加请求生命周期与设置热更新。
- `src/host/console.ts` — 面板服务 API + SSE。
- `src/shock/` — `policy.ts`（事件→计划）、`engine.ts`（串行发送、停止即弃）、`safety.ts`（安全闸）、`planStore.ts`、`dryRunSink.ts`。
- `src/dglab/` — Socket V2 协议、控制器、内置中继、波形、Sink。
- `src/config/` — zod schema 与 `settings.json` 读写（`dataDir()` = magpie 配置目录下 `plugin-work/coyotecoder/`）。

## 与老版本的关键差别

老版本自带 OpenAI 兼容代理（`src/proxy/`）、Fastify API、React 控制台和 Tauri 外壳——都删了。事件来源从“解析 SSE”换成“magpie 网关钩子”，所以：

- 网关钩子只在请求开始和输出结束各触发一次，**没有 chunk**；`response.chunk` 是插件自己的节拍器按时间模拟的（上限 20 次）。
- 不要再引入代理层：magpie 已经在做这件事。

## 安全规则（不能破）

真实输出必须同时满足：`dglab.enabled`、Socket V2 连上并绑定、`safety.dry_run: false`、`safety.armed: true`，且计划通过 SafetyGate。

- 永不绕过 SafetyGate 发真实输出。
- 默认必须保持 `dry_run: true`、`armed: false`；而且 `armed` **不写盘**。
- 面板的急停（`POST /api/panic`）必须一直可用，并且要真的下膛 + 归零。
- 不要保存原始 prompt / 响应内容。
- 降级路径是例外且必须保持：`shock.zero` / `shock.clear` 绕过 SafetyGate，下膛也照发；停止输出的东西（急停、退出、断线、自动下膛）必须真的到达硬件，归零后要 `flush()`。
- armed 不能比 DG-LAB 链路活得久：`dglab.disconnected` → `safety.notifyLinkLost()`。

动退出 / 急停 / sink 时，`src/host/runtime.test.ts`、`src/dglab/sink.test.ts`、`src/shock/safety.test.ts` 必须继续通过——它们是 `docs/safety.md` 承诺的回归测试。

## 配置

- 插件选项（magpie `plugins.json`）：`port`（面板端口，也是 `magpie.page.service` 的端口）、`socketUrl`、`relayBindHost`、`gatewayTimeoutMs`。
- 其余在 `settings.json`，由控制面板写；schema 是 `src/config/schema.ts`，改字段记得同步 `console/` 里的表单。
- `COYOTECODER_HOME` 可以把 `plugin-work/coyotecoder/` 挪到别处（测试用得到）。

## 注意

不要提交 / 修改生成物与运行时目录：`node_modules/`、`plugin-work/`、`.runtime/`、`.test-logs/`。`DG-LAB-OPENSOURCE/` 是本地协议参考，已被忽略。
