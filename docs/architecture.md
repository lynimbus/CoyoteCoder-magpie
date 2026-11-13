# 架构

## 一句话

magpie 是网关，这个插件是网关旁边的一只耳朵：`onRequest` / `onResponse` 把 agent 的动静变成事件，事件变成电流计划，计划过安全闸，闸后才是设备。

```text
agent（Codex / Claude Code / …）
        │
        ▼
magpie 网关 ──hooks.onRequest──► 事件 request.started / response.started
        │                         └ 插件自己的节拍器 → response.chunk
        │
        └──hooks.onResponse───► 事件 response.done / tool_call / error
                                          │
                                          ▼
                                    ShockPolicy     事件 → 通道计划（强度/时长/波形）
                                          │
                                          ▼
                                    ShockEngine     串行化：clear → setStrength → pulse 不可交错
                                          │
                                          ▼
                                     SafetyGate     急停/上膛/会话/空闲/间隔/速率/上限/爬升/时长
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                        DryRunSink               DglabSink → DglabController → 内置中继 ← 手机 App
```

## 为什么不再有代理

老版本自带一个 OpenAI 兼容代理（下游改 Base URL 指向它），因为那时它得自己接住流量才能看见“流式输出第几块”。

magpie 已经是那个代理了，所以：

- `src/proxy/`、`src/api/`、Tauri 外壳、React 控制台全部删除；
- 事件来源从“解析 SSE”换成“magpie 的网关钩子”。

代价要说清楚：网关钩子只在**请求开始**和**输出结束**各触发一次，中间没有 chunk。所以：

- `response.chunk`（“生成中”的脉冲）由插件自己的节拍器按时间爬升模拟，最多 `MAX_STREAM_TICKS`（20 次）就停，免得一个忘了结束的请求一直输出；
- `response.done` 的强度仍按输出 token 数算（`usage` 里能读到就按它，读不到就退回固定值）。

## 进程与文件

magpie 用一个 Bun 宿主进程加载插件。这个进程里同时活着：

| 文件 | 干什么 |
| --- | --- |
| `index.ts` | `main`。宿主入口：建运行时（DG-LAB 链路 + 内置中继 + 控制面板服务）。返回空 hooks —— 它不提供模型，只提供反馈。 |
| `hooks.ts` | `magpie.hooks`。`onRequest` / `onResponse`，两个都必须快（`gatewayTimeoutMs` 默认 2000ms），所以只做“记一笔事件”，不 await 设备。 |
| `page/` | `magpie.page`。带路页：把自己导航到控制面板服务（页面 CSP 是 `connect-src 'none'`，它能做的联网动作只有这一个）。 |
| `console/` | 控制面板本体，由插件自己的 HTTP 服务提供，可以自由 fetch / EventSource。 |
| `src/host/runtime.ts` | 运行时：把 bus / policy / engine / safety / sink / controller / relay 接到一起，另外负责请求生命周期与设置热更新。 |
| `src/host/console.ts` | 面板服务的 HTTP API（状态、上膛/下膛/急停、映射、测试脉冲、SSE 事件流）。 |

`hooks.ts` 和 `index.ts` 通过 `getRuntime()` 共用同一个运行时实例（模块级单例）。

## 面板为什么这样开门

magpie 的插件页面在 `sandbox="allow-scripts"` 的框架里，没有 `allow-same-origin`，所以带路页跳进面板之后仍然是 **opaque origin**。由此有三条硬要求，少一条面板就是白屏或哑巴：

1. **不能有 `frame-ancestors`。** 面板是被 magpie 的窗口框住的，那个 origin 不是自己；`frame-ancestors 'self'` 会让整页直接不渲染。CSP 里也不能只写 `'self'`，得把 `http://127.0.0.1:*`、`http://localhost:*` 明确写出来，opaque origin 下 `'self'` 匹配不到任何东西。
2. **要给 `Origin: null` 回 CORS。** opaque origin 发出的 fetch / EventSource 都算跨域，响应里没有 `access-control-allow-origin: null` 就读不到内容；还得处理 `OPTIONS` 预检（带 JSON 的 POST 一定触发）。来自真实站点的 Origin 一律不回 CORS，直接拒。
3. **要一次口令。** 页面能被任何人框住，所以每次启动生成一个随机 key，注入面板 HTML 的 `<meta name="coyotecoder-key">`，`/api/*` 全部校验：fetch 走 `x-coyotecoder-key` 头，EventSource / `<img>` 走 `?key=`。key 只存在于内存和这次响应里，不落盘。

另外 Host 头只认本机实际监听的端口名，挡 DNS rebinding。

## 事件与计划

事件类型见 `src/events/types.ts`；`ShockPolicy.plan()` 是纯函数式映射：`request.started` → 短脉冲，`response.chunk` → 持续计划（`continuous: true`），`response.done` → 按 token 缩放，`response.error` / `safety.panic` → 两个通道归零。

`ShockEngine` 把发送串成一条链（一次 DG-LAB 输出是 clear/setStrength/pulse 三帧，交错就会把两份计划混在一起），并且每次停止事件都会 `generation++`：停止前排队的工作直接丢弃，不会被 panic 之后再发出去。

## 停不下来的几条线

- 断线（`dglab.disconnected`）→ `safety.notifyLinkLost()`，armed 不能比链路活得久；
- 自动下膛（会话超时 / 空闲超时 / 断线）→ 真的撤回排队脉冲 + 归零，不是只翻标志位；
- 退出（`panic_zero_on_exit`）→ 停止收新计划 → 排空队列 → 撤回转发 → 归零 → 等帧离开 socket → 才关传输层。

细节见 [safety.md](safety.md)。

## 配置

- 插件选项（magpie 的 plugins.json）：`port`、`socketUrl`、`relayBindHost`、`gatewayTimeoutMs`。
- 其余设置在本插件自己的 `settings.json`（magpie 配置目录下 `plugin-work/coyotecoder/`），由控制面板写，schema 在 `src/config/schema.ts`（zod）。
- `safety.armed` **不写盘**：重启后一定是未上膛。
