# 协议笔记

DG-LAB 的官方开源仓库在本机作为外部参考保存：

\`\`\`text
DG-LAB-OPENSOURCE/
\`\`\`

这个目录被仓库忽略，方便独立于官方源码更新。

## 现在的链路

1. 请求从 magpie 的网关经过，插件的 \`hooks.ts\` 收到 \`onRequest\` / \`onResponse\`。
2. \`src/host/runtime.ts\` 把它们变成规范化的事件（见 \`src/events/types.ts\`）。
3. \`ShockPolicy\` 把事件变成通道计划。
4. \`SafetyGate\` 在任何 sink 之前拦截、夹紧或急停。
5. \`DglabSink\` 通过 Socket V2 控制器，把被允许的计划发到内置中继，再转给手机 App。

默认仍然安全：\`safety.dry_run: true\`、\`safety.armed: false\`。真实输出必须显式关空转并上膛。

## 中继

插件自带 Socket V2 中继（\`src/dglab/relay.ts\`），因此不需要另外跑 dglab-websocket-server。

几点协议上的事实：

- 手机 App 连上中继后会发 \`bind\`（type 1），控制器据此拿到 \`targetId\`；
- 一次输出是 \`clear\`（type 4）→ \`setStrength\`（type 3）→ \`pulse\`（\`clientMsg\`）三帧，不能交错；
- 中继对 \`pulse\` 的重复转发有 60 秒上限（\`MAX_PULSE_SECONDS\`），撤回时要把队列里所有定时器清掉；
- 官方 App 无法携带自定义密钥，所以中继拒绝来自非私有网段的连接（\`relay_allow_public: false\`）。

## 波形

可以放 DG-LAB V3 波形文件到 \`waveforms/\`（或设 \`COYOTE_WAVEFORMS_DIR\`）。策略条目里的 \`waveform_id\` 指向它们，找不到就退回内置波形。控制面板的「反馈映射」与「试一下」会列出当前目录里的全部波形。

参考位置：

\`\`\`text
DG-LAB-OPENSOURCE/socket/v2/README.md
DG-LAB-OPENSOURCE/socket/v2/backend
DG-LAB-OPENSOURCE/socket/DG_WAVES_V2_V3_simple.js
\`\`\`
