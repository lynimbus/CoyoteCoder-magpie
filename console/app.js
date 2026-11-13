"use strict";

/* CoyoteCoder 控制面板：原生 JS，无构建、无外部依赖。
   这一页由插件自己的 HTTP 服务提供，所以可以正常 fetch/SSE —— magpie 那个
   页面框架的 connect-src 'none' 不适用于这里（见 page/boot.js）。 */

const POLICY_ROWS = [
  "request_started",
  "response_started",
  "response_chunk",
  "response_tool_call",
  "response_error_status",
  "response_done"
];

const EVENT_NAMES = {
  "request.started": "请求开始",
  "response.started": "开始输出",
  "response.chunk": "生成中",
  "response.done": "完成",
  "response.tool_call": "工具调用",
  "response.error_status": "报错",
  "response.error": "失败",
  "response.aborted": "中止",
  "dglab.connected": "中继已连",
  "dglab.bound": "设备已绑定",
  "dglab.disconnected": "中继断开",
  "dglab.feedback": "设备反馈",
  "dglab.strength_report": "设备强度",
  "dglab.test": "测试",
  "safety.armed": "已上膛",
  "safety.disarmed": "已下膛",
  "safety.panic": "急停"
};

/** 窗口主题：magpie 的 bridge 把真实配色算好了，从这里挂到 :root 上。 */
const LOOK_TOKENS = new Set();

function paintLook(theme) {
  if (!theme || typeof theme !== "object") return;
  const root = document.documentElement;
  const dark = typeof theme.dark === "boolean" ? theme.dark : null;
  if (dark !== null) root.dataset.theme = dark ? "dark" : "light";
  const tokens = theme.tokens && typeof theme.tokens === "object" ? theme.tokens : {};
  const now = new Map();
  for (const [key, value] of Object.entries(tokens)) {
    const text = String(value ?? "").trim();
    if (text) now.set(key.startsWith("--") ? key : `--magpie-${key}`, text);
  }
  // 上一套主题留下的变量要撤掉，否则浅色主题没带的键会沿用深色时的值。
  for (const name of LOOK_TOKENS) if (!now.has(name)) root.style.removeProperty(name);
  for (const [name, text] of now) root.style.setProperty(name, text);
  LOOK_TOKENS.clear();
  for (const name of now.keys()) LOOK_TOKENS.add(name);
}

(function applyWindowLook() {
  let params = null;
  try { params = new URLSearchParams(location.search); } catch { params = null; }
  const theme = String(params?.get("theme") ?? "").toLowerCase();
  const look = {};
  if (theme === "dark" || theme === "light") look.dark = theme === "dark";
  const raw = params?.get("tokens");
  if (raw) {
    try {
      const tokens = JSON.parse(decodeURIComponent(escape(atob(raw))));
      if (tokens && typeof tokens === "object") look.tokens = tokens;
    } catch { /* 解不开就当没带 */ }
  }
  paintLook(look);
})();

/* ---- 自绘下拉（magpie 的 .pop 那种） ---------------------------------------
   原生 <select> 的弹出列表不吃页面的配色，暗色主题下永远是白底。magpie
   自己的下拉全部是 .pop 自绘层，所以没这问题——这里照着做：select 本体留在
   DOM 里当数据源（选项、值、change 都照旧），只是藏起来不显示；
   fillPolicy/fillTestWaves 后来创建的 select 由下面的观察器自动接管，
   那些代码一行不用改。 */

const MENUS = [];
const CHECK_SVG =
  '<svg viewBox="0 0 10 10" width="11" height="11" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.2l2 2L8 3"/></svg>';

function syncMenus() {
  for (const menu of MENUS) menu.sync();
}

function mountMenu(select) {
  if (select.dataset.menuBuilt) return;
  select.dataset.menuBuilt = "1";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "menu-val";
  button.append(label);

  const pop = document.createElement("div");
  pop.className = "pop";
  const list = document.createElement("ul");
  pop.append(list);

  const items = [];
  let isOpen = false;
  let leaveTimer = 0;

  function sync() {
    label.textContent = select.selectedOptions[0]?.textContent ?? "";
    for (const item of items) {
      const on = item.dataset.v === select.value;
      item.classList.toggle("cur", on);
      item.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function rebuild() {
    items.length = 0;
    list.textContent = "";
    for (const option of select.options) {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.dataset.v = option.value;
      item.append(option.textContent);
      item.insertAdjacentHTML("beforeend", `<span class="check">${CHECK_SVG}</span>`);
      item.addEventListener("click", () => {
        if (select.value !== item.dataset.v) {
          select.value = item.dataset.v;
          // 本地已选、还没保存：paint() 刷新时别把它刷回去（见 fillChannel/fillWaves）。
          select.dataset.dirty = "1";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // 立刻同步按钮文字和选中高亮：paint() 最晚 2 秒后才跑，不等它。
        sync();
        close();
        button.focus();
      });
      items.push(item);
      list.append(item);
    }
    sync();
  }

  function place() {
    const rect = button.getBoundingClientRect();
    pop.style.minWidth = `${Math.max(Math.round(rect.width), 120)}px`;
    const height = pop.offsetHeight;
    const down = innerHeight - rect.bottom >= Math.min(height + 12, 200) || rect.top < height + 12;
    const top = down ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
    const ox = Math.min(24, rect.width / 2);
    pop.style.setProperty("--pop-dy", down ? "-6px" : "6px");
    pop.style.transformOrigin = `${ox}px ${down ? "top" : "bottom"}`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(Math.min(rect.left, innerWidth - pop.offsetWidth - 8))}px`;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    clearTimeout(leaveTimer);
    pop.classList.remove("leaving");
    pop.classList.add("on");
    button.classList.add("on");
    button.setAttribute("aria-expanded", "true");
    place();
    // 键盘打开时把焦点挪到当前项上，之后方向键/回车就能选。
    const current = items.find((item) => item.classList.contains("cur")) ?? items[0];
    if (document.activeElement === button && current) current.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
    pop.classList.remove("on");
    pop.classList.add("leaving");
    leaveTimer = setTimeout(() => pop.classList.remove("leaving"), 170);
  }

  button.addEventListener("click", () => (isOpen ? close() : open()));
  document.addEventListener("pointerdown", (event) => {
    if (!isOpen) return;
    if (pop.contains(event.target) || button.contains(event.target)) return;
    close();
  });
  document.addEventListener("keydown", (event) => {
    if (!isOpen || event.key !== "Escape") return;
    close();
    button.focus();
  });
  // 弹层是 fixed 定位，页面一滚就脱锚：干脆收起（弹层自己列表的滚动除外）。
  window.addEventListener(
    "scroll",
    (event) => {
      if (isOpen && event.target !== list) close();
    },
    true
  );
  window.addEventListener("resize", () => {
    if (isOpen) close();
  });
  pop.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const from = items.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(from + step + items.length) % items.length]?.focus();
  });

  // 选项变了就重建（fillWaves/fillTestWaves 填充时触发）。
  new MutationObserver(rebuild).observe(select, { childList: true });

  select.insertAdjacentElement("afterend", button);
  document.body.append(pop);
  select.hidden = true;
  rebuild();

  MENUS.push({ sync });
}

// 页面里已有的 select 先接管；paintPolicy/fillTestWaves 后来才创建的靠观察器补挂。
document.querySelectorAll("select").forEach(mountMenu);
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node instanceof HTMLSelectElement) mountMenu(node);
      node.querySelectorAll?.("select").forEach(mountMenu);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// 这一页常驻（package.json 里 magpie.page.keepAlive），开局那次跳转之后就再也
// 不会重新载入了，magpie 换主题时只往这个窗口发一条消息。协议和 magpie 的
// bridge 一致：{ magpie: 1, event: "theme", data: { dark, tokens, lang } }。
// 不收的话，面板会永远停在第一次打开时的那套配色上。
addEventListener("message", (event) => {
  if (event.source !== parent && !(window.opener && event.source === window.opener)) return;
  const message = event.data;
  if (!message || message.magpie !== 1 || message.event !== "theme") return;
  paintLook(message.data);
});

const $ = (id) => document.getElementById(id);

/** 页面口令：服务端的每次启动重新生成，塞在这个 meta 里。
    magpie 的框架是 opaque origin，/api 没有口令一律 401。 */
const KEY = document.querySelector('meta[name="coyotecoder-key"]')?.content ?? "";

/** 能带 header 的用 header，不能的（EventSource、<img>）用 query。 */
function withKey(path) {
  if (!KEY) return path;
  return `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}`;
}
let state = null;
let catalog = [];
let lastLogAt = 0;
let refreshing = null;

async function api(path, body) {
  const headers = { "x-coyotecoder-key": KEY };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({ ok: false, error: `http-${response.status}` }));
  return payload;
}

function scheduleRefresh(delay = 150) {
  if (refreshing) return;
  refreshing = setTimeout(async () => {
    refreshing = null;
    try { await refresh(); } catch { /* 下一轮再试 */ }
  }, delay);
}

async function refresh() {
  const next = await api("/api/state");
  if (next && next.ok !== false) {
    state = next;
    paint();
  }
}

function paint() {
  if (!state) return;
  const { safety, dglab, config } = state;
  const address = state.console ? `${state.console.host}:${state.console.port}` : "—";
  $("address").textContent = address;

  const linked = dglab.connected === true;
  const bound = dglab.bound === true;
  // `connected` only says the socket to the relay the plugin runs itself is up,
  // which is true with no phone in sight. Only `bound` means a device is there.
  setState("st-link", bound ? "设备已绑定" : linked ? "中继在线" : "未连接", bound ? "good" : linked ? "warn" : "bad");
  setState("st-armed", safety.armed ? "已上膛" : "未上膛", safety.armed ? "good" : "");
  setState("st-dry", safety.dryRun ? "空转" : "真实下发", safety.dryRun ? "warn" : "bad");

  const banner = $("banner");
  if (safety.panic) {
    banner.hidden = false;
    banner.textContent = "急停已锁死：先解除急停才能重新上膛（下膛后再上膛）。";
    banner.dataset.level = "danger";
  } else if (!safety.dryRun) {
    banner.hidden = false;
    banner.textContent = "空转已关闭，满足条件时电流会真的下发。随时可以按急停。";
    banner.dataset.level = "warn";
  } else {
    banner.hidden = true;
  }

  $("f-connected").textContent = linked ? "中继已连" : (dglab.lastError ? `未连接（${dglab.lastError}）` : "未连接");
  $("f-bound").textContent = bound ? `client ${short(dglab.clientId)} → target ${short(dglab.targetId)}` : "等待手机扫码";
  $("f-socket").textContent = dglab.qrSocketUrl ?? config.dglab.socket_url;
  const strengths = dglab.strengths;
  $("f-strength").textContent = strengths
    ? `A ${strengths.A}（软限 ${strengths.softLimitA}） · B ${strengths.B}（软限 ${strengths.softLimitB}）`
    : "—";

  const qr = $("qr");
  const empty = $("qr-empty");
  if (dglab.qrLink) {
    qr.hidden = false;
    empty.hidden = true;
    const src = withKey(`/api/qr.svg?t=${Date.now()}`);
    if (qr.getAttribute("src") !== src) qr.setAttribute("src", src);
  } else {
    qr.hidden = true;
    empty.hidden = false;
    empty.textContent = linked ? "等设备分配 clientId…" : "中继还没连上";
  }

  paintPairHint(dglab);
  paintSafety(config, safety);
  paintPolicy(config);
  paintLog();
  // fillPolicy/fillTestWaves 直接改 select.value 不派事件，菜单的标签在这里同步。
  syncMenus();
}

/** Explains the gap between "the relay is up" and "a phone is paired". */
function paintPairHint(dglab) {
  const hint = $("qr-hint");
  if (dglab.bound === true) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  // null means the relay is run by another process, so its counters are unknown.
  const peerSeen = dglab.relay ? dglab.relay.externalConnects > 0 : null;
  const text =
    dglab.connected !== true
      ? "中继没起来，先看插件日志里 relay 的报错。"
      : peerSeen === false
        ? "中继起来了，但手机还没连上过。扫了码没反应，一般是本机防火墙没放行手机地址上的端口。"
        : peerSeen === true
          ? "手机连上过却没完成绑定：在 App 里看 Socket 连接状态，或者重新扫一次码。"
          : "扫码没反应时，先确认手机与电脑在同一网络、且防火墙放行手机地址上的端口。";
  hint.hidden = false;
  hint.textContent = text;
}

function short(value) {
  return typeof value === "string" && value.length > 10 ? `${value.slice(0, 6)}…` : (value ?? "—");
}

function setState(id, text, level) {
  const el = $(id);
  el.querySelector("b").textContent = text;
  el.dataset.level = level ?? "";
}

function paintSafety(config, safety) {
  setValue("s-limit-a", config.safety.channel_limits.A);
  setValue("s-limit-b", config.safety.channel_limits.B);
  setValue("s-continuous", config.safety.max_continuous_output_ms);
  setValue("s-rate", config.safety.max_events_per_minute);
  setValue("s-step", config.safety.max_intensity_step);
  setValue("s-interval", config.safety.min_interval_ms);
  setValue("s-session", config.safety.max_session_ms);
  setValue("s-idle", config.safety.idle_disarm_ms);
  // 同反馈映射的下拉：未保存的本地改动不被周期刷新顶掉，保存生效后自动解除。
  const soft = $("s-soft");
  if (soft.dataset.dirty) {
    if (soft.checked === (config.safety.respect_device_soft_limit === true)) delete soft.dataset.dirty;
  } else {
    soft.checked = config.safety.respect_device_soft_limit === true;
  }
  $("s-dry").checked = safety.dryRun === true;

  const effective = safety.effectiveLimits;
  const parts = [];
  parts.push(`实发上限 A ${effective?.A ?? "—"} / B ${effective?.B ?? "—"}`);
  if (safety.deviceSoftLimits) parts.push(`设备软限 A ${safety.deviceSoftLimits.A} / B ${safety.deviceSoftLimits.B}`);
  parts.push(`一分钟内 ${safety.recentEventsInWindow}/${safety.maxEventsPerMinute} 个事件`);
  if (safety.sessionRemainingMs !== undefined && safety.sessionRemainingMs !== null) {
    parts.push(`会话剩余 ${Math.round(safety.sessionRemainingMs / 1000)}s`);
  }
  if (safety.idleRemainingMs !== undefined && safety.idleRemainingMs !== null) {
    parts.push(`空闲下膛倒计时 ${Math.round(safety.idleRemainingMs / 1000)}s`);
  }
  if (safety.lastBlockReason) parts.push(`上次拦截：${safety.lastBlockReason}`);
  $("edge").textContent = parts.join(" · ");
}

function setValue(id, value) {
  const el = $(id);
  if (document.activeElement === el) return;
  if (el.dataset.dirty) {
    // 编辑过、还没保存：服务器值追上来才算解除标记，否则保持本地值。
    if (inputCaughtUp(el, value)) delete el.dataset.dirty;
    return;
  }
  el.value = value ?? "";
}

/** 输入框里的本地值和服务器值是不是同一个数（"0.30" 和 0.3 也算追上）。 */
function inputCaughtUp(el, value) {
  const raw = el.value;
  if (raw.trim() === "") return false; // 清空视为还没改完，继续跳过覆盖
  const local = Number(raw);
  return Number.isFinite(local) && local === Number(value);
}

// 目录里永远有内置「默认」（id 为 default），所以下拉框不再额外塞一个
// 空值占位项——那会和它重名。目录加载失败时才退回空值占位。
function defaultWaveId() {
  return catalog.find((w) => w.id === "default")?.id ?? "";
}

function displayWaveId(id) {
  if (id && catalog.some((w) => w.id === id)) return id;
  return defaultWaveId();
}

function paintPolicy(config) {
  const waves = catalog.length > 0 ? catalog.map((w) => w.id) : [""];
  for (const key of POLICY_ROWS) {
    const row = document.querySelector(`tr[data-key="${key}"]`);
    if (!row) continue;
    const item = config.policy[key];
    if (!item) continue;
    fillChannel(row.querySelector(".ch"), item.channel);
    for (const input of row.querySelectorAll("input[data-f]")) {
      const field = input.dataset.f;
      if (document.activeElement === input) continue;
      if (input.dataset.dirty) {
        if (inputCaughtUp(input, item[field] ?? "")) delete input.dataset.dirty;
        continue;
      }
      input.value = item[field] ?? "";
    }
    fillWaves(row.querySelector(".wave"), waves, displayWaveId(item.waveform_id));
  }
  setValue("p-tokens", config.policy.response_done.token_target);
  setValue("p-tick", config.policy.response_chunk.tick_ms);
}

function fillChannel(cell, current) {
  if (!cell) return;
  if (cell.dataset.built) {
    const select = cell.firstElementChild;
    // 自绘下拉下焦点永远不在隐藏的 select 上，activeElement 挡不住周期刷新；
    // 未保存的本地选择跳过覆盖，保存生效（服务器值追上来）时解除标记。
    if (select?.dataset.dirty) {
      if (select.value === current) delete select.dataset.dirty;
      return;
    }
    if (document.activeElement !== select) select.value = current;
    return;
  }
  const select = document.createElement("select");
  for (const value of ["A", "B"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = current ?? "A";
  cell.append(select);
  cell.dataset.built = "1";
}

function fillWaves(cell, waves, current) {
  if (!cell) return;
  if (cell.dataset.built) {
    const select = cell.firstElementChild;
    if (select?.dataset.dirty) {
      if (select.value === current) delete select.dataset.dirty;
      return;
    }
    if (document.activeElement !== select) select.value = current;
    return;
  }
  const select = document.createElement("select");
  select.innerHTML = "";
  for (const id of waves) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id === "" ? "默认" : (catalog.find((w) => w.id === id)?.name ?? id);
    select.append(option);
  }
  select.value = current;
  cell.append(select);
  cell.dataset.built = "1";
}

function fillTestWaves() {
  const select = $("t-wave");
  if (select.dataset.built) return;
  for (const id of catalog.length > 0 ? catalog.map((w) => w.id) : [""]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id === "" ? "默认" : (catalog.find((w) => w.id === id)?.name ?? id);
    select.append(option);
  }
  select.value = defaultWaveId();
  select.dataset.built = "1";
}

const logLines = [];

function paintLog() {
  const list = $("log");
  list.innerHTML = "";
  for (const line of logLines) {
    const item = document.createElement("li");
    item.dataset.level = line.level ?? "";
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = new Date(line.at).toLocaleTimeString();
    const text = document.createElement("span");
    text.className = "n";
    text.textContent = line.text;
    item.append(time, text);
    list.append(item);
  }
}

function pushLog(event) {
  const name = EVENT_NAMES[event.type] ?? event.type;
  const extra = [];
  if (event.type === "response.done") {
    if (event.outputTokens) extra.push(`${event.outputTokens} tok`);
    if (event.durationMs) extra.push(`${(event.durationMs / 1000).toFixed(1)}s`);
  }
  if (event.type === "response.error_status") extra.push(`HTTP ${event.statusCode}`);
  if (event.type === "response.tool_call") extra.push(`${event.toolCallCount} 次`);
  if (event.type === "request.started" && event.model) extra.push(event.model);
  logLines.unshift({
    at: event.timestamp ?? Date.now(),
    text: extra.length > 0 ? `${name} · ${extra.join(" · ")}` : name,
    level: event.type.startsWith("safety.") ? "warn" : (event.type === "response.error" ? "danger" : "")
  });
  if (logLines.length > 80) logLines.length = 80;
  paintLog();
}

function subscribe() {
  try {
    const source = new EventSource(withKey("/api/events"));
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        pushLog(event);
        if (Date.now() - lastLogAt > 400) {
          lastLogAt = Date.now();
          scheduleRefresh(400);
        }
      } catch { /* 忽略坏帧 */ }
    };
    source.onerror = () => { /* 浏览器自己会重连 */ };
  } catch { /* 没有 SSE 就靠轮询 */ }
}

function collectSafety() {
  return {
    safety: {
      channel_limits: { A: num("s-limit-a"), B: num("s-limit-b") },
      max_continuous_output_ms: num("s-continuous"),
      max_events_per_minute: num("s-rate"),
      max_intensity_step: number("s-step"),
      min_interval_ms: num("s-interval"),
      max_session_ms: num("s-session"),
      idle_disarm_ms: num("s-idle"),
      respect_device_soft_limit: $("s-soft").checked,
      dry_run: $("s-dry").checked
    }
  };
}

function collectPolicy() {
  const policy = {};
  for (const key of POLICY_ROWS) {
    const row = document.querySelector(`tr[data-key="${key}"]`);
    if (!row) continue;
    const item = {};
    const channel = row.querySelector(".ch select");
    if (channel) item.channel = channel.value;
    const wave = row.querySelector(".wave select");
    // 选回「默认」时存 null，保持 settings 里“空 = 内置默认”的语义。
    if (wave) item.waveform_id = wave.value === "" || wave.value === "default" ? null : wave.value;
    for (const input of row.querySelectorAll("input[data-f]")) {
      item[input.dataset.f] = Number(input.value);
    }
    policy[key] = item;
  }
  policy.response_done.token_target = num("p-tokens");
  policy.response_chunk.tick_ms = num("p-tick");
  return { policy };
}

function num(id) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? value : undefined;
}

function number(id) {
  return num(id);
}

function wire() {
  // 数字输入也要 dirty 标记，和下拉对齐：编辑过、还没保存的字段，
  // 周期刷新（2 秒轮询 + SSE 事件后 400ms）不能把它刷回去。
  // 用委托挂一次，paintPolicy 后建的行也能捕到。
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el instanceof HTMLInputElement && el.type !== "checkbox" && el.type !== "radio") {
      el.dataset.dirty = "1";
    }
  });
  $("arm").addEventListener("click", async () => {
    const next = await api("/api/arm", {});
    if (next?.ok !== false) { state = next; paint(); } else { alert(next?.error ?? "上膛失败"); }
  });
  $("disarm").addEventListener("click", async () => {
    const next = await api("/api/disarm", {});
    if (next?.ok !== false) { state = next; paint(); }
  });
  $("panic").addEventListener("click", async () => {
    const next = await api("/api/panic", {});
    if (next?.ok !== false) { state = next; paint(); }
  });
  $("s-dry").addEventListener("change", async () => {
    const next = await api("/api/dry-run", { enabled: $("s-dry").checked });
    if (next?.ok !== false) { state = next; paint(); }
  });
  // 勾选后到点保存之前，周期刷新不能把它翻回去。
  $("s-soft").addEventListener("change", () => { $("s-soft").dataset.dirty = "1"; });
  $("save-safety").addEventListener("click", async () => {
    const next = await api("/api/settings", collectSafety());
    if (next?.ok !== false) { state = next; paint(); } else { alert(next?.error ?? "保存失败"); }
  });
  $("save-policy").addEventListener("click", async () => {
    const next = await api("/api/settings", collectPolicy());
    if (next?.ok !== false) { state = next; paint(); } else { alert(next?.error ?? "保存失败"); }
  });
  $("test").addEventListener("click", async () => {
    const next = await api("/api/test", {
      channel: $("t-channel").value,
      intensity: Number($("t-intensity").value),
      durationMs: Number($("t-duration").value),
      waveId: $("t-wave").value === "" ? undefined : $("t-wave").value
    });
    if (next?.ok !== false) { state = next; paint(); }
  });
}

(async () => {
  wire();
  try {
    const response = await api("/api/waves");
    catalog = Array.isArray(response?.waveforms) ? response.waveforms : [];
  } catch {
    catalog = [];
  }
  fillTestWaves();
  try { await refresh(); } catch { /* 下一轮 */ }
  subscribe();
  setInterval(() => { void refresh().catch(() => undefined); }, 2000);
})();
