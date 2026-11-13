<div align="center">

<img src="./CoyoteCoder.png" alt="CoyoteCoder" width="128" />

# CoyoteCoder

![Type](https://img.shields.io/badge/magpie-plugin-e5484d)
![Hooks](https://img.shields.io/badge/magpie.hooks-onRequest%20%2F%20onResponse-555)
![Page](https://img.shields.io/badge/magpie.page-控制面板-555)

把 magpie 里 agent 的一举一动，变成 DG-LAB 郊狼的反馈。

让 Vibe Coding 更有参与感。

</div>

## 它是什么

CoyoteCoder 现在是 [magpie](https://usemagpie.ai/docs/plugins) 的一个插件，不再是自带代理和桌面窗口的独立程序。

magpie 自己就是所有 agent 请求的网关（Codex、Claude Code、Cursor……都由它转发），所以这个插件不再需要接住流量，而是用 magpie 的**网关钩子**旁听每一次请求：

- `onRequest`：一次 agent 请求开始 —— 上通道 A 的一个短脉冲；
- 请求进行中：插件自己的节拍器按时间爬升，模拟“模型正在写”；
- `onResponse`：输出结束 —— 按输出 token 数决定完成脉冲的强度；有工具调用、报错各有自己的映射；
- 请求失败：先归零，再按状态码给一个“不高兴”的脉冲。

再加上一个 **magpie 页面**（侧栏「郊狼反馈」）作为控制面板：上膛/下膛/急停、强度上限、事件映射、波形选择、配对二维码、实时事件流。

## 装进 magpie

```bash
# 本地文件夹（开发时）
magpie plugin add /path/to/CoyoteCoder-magpie

# 或者 github 上的仓库（带 magpie-plugin 标签）
magpie plugin add you/CoyoteCoder
```

装好后在 magpie 的 **Plugins** 页把它打开，侧栏 Plugins 分组里就出现「郊狼反馈」。

详细步骤（含手机配对）见 [docs/install.md](docs/install.md)。

## 默认是安全的

- `dry_run` 默认 **开**：计划照算、日志照写，什么都不发到设备。
- `armed` 默认 **关**，而且**永远不写盘**：重启后一定是未上膛状态。
- 是否真的会电到人，要同时满足：插件开着、DG-LAB 链路连上并绑定、`dry_run` 关、已上膛、并且通过安全闸（强度上限 ∩ 设备软限、爬升步进、最小间隔、速率、会话时长、空闲下膛）。
- 急停（面板上的红色按钮）直接给设备归零，不依赖事件链路是否健康；退出、断线、自动下膛同样会真的归零，而不是只翻一个标志位。

完整的分层说明见 [docs/safety.md](docs/safety.md)。

## 控制面板

面板由插件自己起的一个本地 HTTP 服务提供（默认 `http://127.0.0.1:8787/`，可用插件选项 `port` 改）。magpie 的页面框架因为 `connect-src 'none'` 不能联网，所以那一页只做一件事：把自己导航到这个服务（见 `page/boot.js`）。面板本身可以正常 `fetch` 和 `EventSource`。

在 `magpie web`（用另一台机器的浏览器打开）时，桥接会给出 `magpie.service`，页面会跳到 magpie 自己的转发地址，而不是看页面那台机器的 `127.0.0.1`。

## 目录

```text
index.ts          magpie 的宿主入口：拉起 DG-LAB 链路、内置中继、控制面板服务
hooks.ts          magpie.hooks：onRequest / onResponse → 事件
page/             magpie 页面（带路页 + 图标）
console/          控制面板本身（HTML/CSS/原生 JS，无构建）
src/host/         运行时：事件接线、控制面板 HTTP API
src/shock/        policy（事件 → 计划）→ engine（串行发送）→ safety（安全闸）
src/dglab/        Socket V2 协议、控制器、内置中继、波形、Sink
src/events/       事件类型与内存事件总线
src/config/       配置 schema（zod）与 settings.json 读写
waveforms/        自定义 DG-LAB V3 波形（放进来就能在面板里选）
docs/             架构、安全、协议笔记、安装
```

## 开发

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest：安全闸、引擎、协议、控制器、中继、波形、运行时
```

插件由 magpie 的 Bun 宿主直接跑 TypeScript，没有构建步骤。`main`、`magpie.hooks` 都指向 `.ts` 文件。
