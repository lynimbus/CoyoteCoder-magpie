# 安装与配对

## 1. 装进 magpie

插件就是一个 npm 包形状的文件夹：根目录有 `package.json`，里面带一个 `magpie` 字段。

```bash
# 本地文件夹：改完立刻生效（重新打开插件或改一次配置即可）
magpie plugin add /path/to/CoyoteCoder-magpie

# 从 GitHub（仓库需要带 magpie-plugin 标签，package.json 在根目录）
magpie plugin add Piracola/CoyoteCoder

# 从 npm
magpie plugin add magpie-coyotecoder
```

装完在 magpie 的 **Plugins** 页打开它。打开后：

- 侧栏 Plugins 分组里多出「郊狼反馈」——那是控制面板；
- magpie 的插件宿主进程里会跑起 DG-LAB 链路和控制面板服务；
- 之后经过 magpie 的每一次 agent 请求都会被 `hooks.ts` 看到。

插件装到哪、配置存哪，由 magpie 决定；本插件的 `settings.json` 写在 magpie 配置目录下的 `plugin-work/coyotecoder/` 里（宿主的工作目录就是 magpie 的配置目录）。想换个地方，可以设环境变量 `COYOTECODER_HOME`。

## 2. 配对手机

1. 手机装官方 **DG-LAB** App。
2. 打开控制面板（侧栏「郊狼反馈」），面板会显示一个二维码。
3. App 里扫码绑定。

二维码指向的地址就是插件内置的 Socket V2 中继：`ws://<本机局域网地址>:9999`。面板「设备」一栏里的 **手机地址** 就是这个地址——注意它不是 `socket_url`（那个是本机回环，插件自己连的）。

**这一步最容易卡住：本机防火墙必须放行这个端口。** 手机连不上时中继收不到任何东西，包在 INPUT 就被丢了，App 只会一直转圈。

- 中继是插件自己起的，不需要另外跑 [dglab-websocket-server](https://github.com/dungeonlab-open/dglab-websocket-server)。
- 中继要能被手机访问，所以它绑在 `0.0.0.0`（`dglab.relay_bind_host` 可以改成某张网卡的具体地址）。控制面板本身只绑 `127.0.0.1`。
- 官方 App 没法携带自定义密钥，所以中继的做法是**拒绝来自非私有网段的连接**，而不是加一个配对时给不出来的 token。
- 面板里 `qr_host` 默认 `auto`：按“手机大概能不能连上”给网卡打分后挑选，虚拟网卡（WSL / Docker / VPN）会被降权。扫不出来就在面板里改成具体地址。
- 放行端口（NixOS 举例）：`networking.firewall.allowedTCPPorts = [ 9999 ];`。

## 3. 让它开始有感觉

1. **先别急着关空转。** 面板上「空转」开着时，一切照算，只是不下发。
2. 打开你常用的 agent（Codex / Claude Code / ...），让它跑一个请求，看面板的「最近事件」是不是在动：
   - 请求开始、生成中、完成；
   - 有工具调用时额外的脉冲；
   - 报错时先是归零。
3. 映射和强度在上限内调着看（「反馈映射」「试一下」）。
4. 确认无误后：清「空转」→ 点「上膛」。

之后只要链路在、请求在走，就会有反馈。想立刻停下：**急停**。

## 4. 常见问题

**面板页一片「正在连接控制面板…」**
控制面板服务没起来。看 magpie 的日志里有没有 `plugin: coyotecoder: …` 的行——端口被占用是最常见的原因（默认 8787，可用插件选项 `port` 换）。

**二维码出不来，一直「中继还没连上」**
中继端口（默认 9999）被别的程序占了，或者 `socket_url` 指向的不是本机。面板「设备」一栏里的 Socket 地址就是它正在用的地址。

**手机扫了但面板显示「未绑定」**
扫码之后要等 App 回连并完成绑定（App 会显示已连接）。面板顶部只说「中继在线」不代表手机在：只有「设备 已绑定」才是真的配上了。

面板的二维码下面会直接告诉你卡在哪一步：

- **手机还没连上过** → 包没进到中继，基本都是本机防火墙没放行「手机地址」上的端口；
- **手机连上过却没完成绑定** → 链路通了，问题在 App 侧，重新扫一次码。

**改了设置没生效**
安全边界和映射是立刻生效的；`socket_url`、`relay_bind_host`、`enabled` 这类要重开链路（保存后面板会自己重连）。
