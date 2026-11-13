// 带路页：把 magpie 给的这个框架导航到插件自己的控制面板服务。
//
// 为什么必须"直接跳"：magpie 页面的策略是 connect-src 'none'，fetch、XHR、
// WebSocket 全被拒绝，连探测一下服务在不在都做不到。文档也说得很清楚：这个
// 页面唯一能做的联网动作就是把自己送到别处。跳过去之后，面板由本插件自己的
// HTTP 服务提供，那份页面的 CSP 由我们自己写，fetch/SSE 都正常。
//
// 跳到哪里：
//   · magpie web（或者别人用浏览器打开这台机器的 magpie）时，bridge 会给出
//     magpie.service —— 那是 magpie 在它自己的地址上替本服务转发的路径，
//     因为那种情形下 127.0.0.1 指的是看页面那台电脑，不是跑服务的机器。
//   · 桌面窗口里没有 magpie.service，就直接去 127.0.0.1。
// 端口取插件选项 port（默认 8787），服务端读的是同一个值。
(async () => {
  const DEFAULT_PORT = 8787;
  let port = DEFAULT_PORT;
  let theme = "";
  let tokens = null;
  let service = "";

  try {
    const t = await window.magpie?.ready;
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch { /* 没有 bridge 就用默认值 */ }

  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && s.trim() !== "") service = new URL(s, location.href).href;
  } catch { /* 旧版 magpie 没有 service */ }

  try {
    const o = await window.magpie?.options?.get?.();
    const given = Number(o && o.port);
    if (Number.isFinite(given) && given > 0 && given <= 65535) port = given;
  } catch { /* 没有 options 就用默认端口 */ }

  const said = document.getElementById("said");
  const target = service !== "" ? service : `http://127.0.0.1:${port}/`;

  const query = new URLSearchParams();
  if (theme) query.set("theme", theme);
  if (tokens) {
    const slim = {};
    for (const [key, value] of Object.entries(tokens)) {
      const text = String(value ?? "").trim();
      if (text) slim[key] = text;
    }
    if (Object.keys(slim).length > 0) {
      try { query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim))))); } catch { /* 传不过去就算了 */ }
    }
  }
  const url = query.toString() === "" ? target : `${target}${target.includes("?") ? "&" : "?"}${query}`;

  if (said) said.textContent = `正在连接控制面板 ${target}`;
  try {
    location.replace(url);
  } catch {
    if (said) said.innerHTML = `控制面板服务没有运行。请在终端看 <code>plugin:</code> 日志，或确认端口 ${port} 空闲。`;
  }
})();
