import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import type { CoyoteEvent } from "../events/types.ts";
import type { CoyoteRuntime } from "./runtime.ts";

const CONSOLE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "console");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
};

const MAX_BODY_BYTES = 64 * 1024;
/** What the panel sends back the key under (the meta tag names it too). */
const KEY_HEADER = "x-coyotecoder-key";
const KEY_META = "@@COYOTECODER_KEY@@";

export interface ConsoleServer {
  address: { host: string; port: number };
  /** Regenerated every launch; the panel reads it from its own <meta>. */
  key: string;
  close: () => Promise<void>;
}

interface Panel {
  runtime: CoyoteRuntime;
  key: string;
  origins: Set<string>;
  hosts: Set<string>;
}

/**
 * The control panel's local service. magpie's page cannot talk to anything
 * itself (its policy is `connect-src 'none'`), so the page hands the frame over
 * to this server, which is served from the plugin's own folder and talks to the
 * runtime directly.
 *
 * That frame is `sandbox="allow-scripts"`, so the panel runs in an **opaque
 * origin**: its `fetch` and `EventSource` calls arrive with `Origin: null`,
 * count as cross-origin, and are only readable with `Access-Control-Allow-Origin:
 * null`. Because anything could then be embedded, every `/api` call also has to
 * carry this launch's page key.
 */
export async function startConsoleServer(runtime: CoyoteRuntime): Promise<ConsoleServer> {
  const { host, port } = runtime.config.console;
  const key = randomBytes(24).toString("base64url");
  const panel: Panel = { runtime, key, origins: new Set(), hosts: new Set() };

  const server = createServer((request, response) => {
    handle(panel, request, response).catch((error: unknown) => {
      console.error(`coyotecoder: console request failed: ${String(error)}`);
      if (!response.headersSent) {
        json(response, 500, { ok: false, error: "internal" }, corsHeaders(panel, request));
      } else {
        response.end();
      }
    });
  });
  // Nothing here may keep the plugin host alive on its own.
  server.unref?.();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    // Resolving is what lets the entry finish: a listener named cleanup here
    // left the runtime waiting forever on a panel that had already bound.
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const bound = server.address();
  const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;
  for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
    panel.origins.add(`http://${name}:${actualPort}`);
    panel.hosts.add(`${name}:${actualPort}`);
  }

  return {
    address: { host, port: actualPort },
    key,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

/**
 * Only this machine's own names reach the panel: a DNS rebinding trick makes a
 * remote name resolve to 127.0.0.1, and the Host header then still says the
 * remote name. `magpie web` forwards with the service's own Host, so this holds
 * there too.
 */
function hostAllowed(panel: Panel, request: IncomingMessage): boolean {
  const host = String(request.headers.host ?? "").toLowerCase();
  return host === "" || panel.hosts.has(host);
}

/**
 * The panel's own origin is opaque ("null"), so that is the one a foreign page
 * cannot fake and the one `sandbox` gives us. A real origin is allowed only
 * when it is this very service in a browser tab.
 */
function originAllowed(panel: Panel, request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === "null" || panel.origins.has(origin);
}

function corsHeaders(panel: Panel, request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  const headers: Record<string, string> = { vary: "origin" };
  if (origin === "null") {
    headers["access-control-allow-origin"] = "null";
  } else if (origin !== undefined && panel.origins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

function keyOk(panel: Panel, request: IncomingMessage, url: URL): boolean {
  const gave = String(request.headers[KEY_HEADER] ?? url.searchParams.get("key") ?? "");
  const got = Buffer.from(gave);
  const want = Buffer.from(panel.key);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(panel: Panel, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { runtime } = panel;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = url.pathname;
  const cors = corsHeaders(panel, request);

  if (!hostAllowed(panel, request)) {
    json(response, 403, { ok: false, error: "bad-host" }, cors);
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...cors,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": `content-type, ${KEY_HEADER}`,
      "access-control-max-age": "86400"
    });
    response.end();
    return;
  }
  if (!originAllowed(panel, request)) {
    json(response, 403, { ok: false, error: "bad-origin" }, cors);
    return;
  }

  const staticFile = STATIC_FILES[route];
  if (staticFile && (request.method === "GET" || request.method === "HEAD")) {
    let body = await readFile(path.join(CONSOLE_DIR, staticFile.file));
    if (staticFile.file === "index.html") {
      // The key goes into the page as a meta tag, never onto disk: a new one is
      // made every launch, so a stale tab cannot outlive the host that made it.
      body = Buffer.from(body.toString("utf8").replaceAll(KEY_META, panel.key));
    }
    response.writeHead(200, {
      "content-type": staticFile.type,
      "cache-control": "no-store",
      // magpie frames this page from its own origin and the frame inherits
      // `sandbox allow-scripts`, so `'self'` matches nothing: name the loopback
      // origins explicitly, and leave framing alone (the panel is reachable on
      // 127.0.0.1 only, and every /api call needs the page key).
      "content-security-policy":
        "default-src 'self' http://127.0.0.1:* http://localhost:*;" +
        " script-src 'self' http://127.0.0.1:* http://localhost:*;" +
        " style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*;" +
        " img-src 'self' data: http://127.0.0.1:* http://localhost:*;" +
        " connect-src 'self' http://127.0.0.1:* http://localhost:*;" +
        " base-uri 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...cors
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }

  if (!route.startsWith("/api/")) {
    json(response, 404, { ok: false, error: "not-found" }, cors);
    return;
  }

  if (!keyOk(panel, request, url)) {
    json(response, 401, { ok: false, error: "unauthorized" }, cors);
    return;
  }

  if (route === "/api/events" && request.method === "GET") {
    streamEvents(runtime, request, response, cors);
    return;
  }

  if (route === "/api/qr.svg" && request.method === "GET") {
    const link = runtime.getState().dglab as { qrLink?: string };
    if (!link.qrLink) {
      json(response, 503, { ok: false, error: "not-bound" }, cors);
      return;
    }
    const svg = await QRCode.toString(link.qrLink, { type: "svg", margin: 1, width: 240 });
    response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store", ...cors });
    response.end(svg);
    return;
  }

  const method = request.method ?? "GET";

  if (route === "/api/state" && method === "GET") {
    json(response, 200, runtime.getState(), cors);
    return;
  }

  if (route === "/api/waves" && method === "GET") {
    const catalog = await runtime.waveforms.getCatalog(true);
    json(response, 200, { ok: true, ...catalog }, cors);
    return;
  }

  if (method !== "POST") {
    json(response, 405, { ok: false, error: "method-not-allowed" }, cors);
    return;
  }

  const body = await readJson(request);

  switch (route) {
    case "/api/settings": {
      let result;
      try {
        result = runtime.applyPatch(body);
      } catch (error) {
        json(response, 400, { ok: false, error: String(error instanceof Error ? error.message : error) }, cors);
        return;
      }
      json(response, 200, { ok: true, reloaded: result.reloaded, ...runtime.getState() }, cors);
      return;
    }
    case "/api/arm": {
      runtime.arm();
      json(response, 200, { ok: true, ...runtime.getState() }, cors);
      return;
    }
    case "/api/disarm": {
      const zeroed = await runtime.disarm();
      json(response, 200, { ok: true, zeroed, ...runtime.getState() }, cors);
      return;
    }
    case "/api/panic": {
      const result = await runtime.panic();
      json(response, 200, { ok: true, ...result, ...runtime.getState() }, cors);
      return;
    }
    case "/api/dry-run": {
      runtime.setDryRun(readBoolean(body, "enabled", true));
      json(response, 200, { ok: true, ...runtime.getState() }, cors);
      return;
    }
    case "/api/zero": {
      const zeroed = await runtime.emergencyZero();
      json(response, 200, { ok: true, zeroed, ...runtime.getState() }, cors);
      return;
    }
    case "/api/test": {
      const channel = readChannel(body);
      const intensity = readNumber(body, "intensity") ?? 0.1;
      const durationMs = readNumber(body, "durationMs") ?? 400;
      const waveId = typeof (body as { waveId?: unknown }).waveId === "string" ? (body as { waveId: string }).waveId : undefined;
      await runtime.testPulse(channel, intensity, durationMs, waveId);
      json(response, 200, { ok: true, ...runtime.getState() }, cors);
      return;
    }
    case "/api/dglab/connect":
    case "/api/dglab/disconnect": {
      json(response, 200, { ok: true, ...(await handleLink(runtime, route)) }, cors);
      return;
    }
    default:
      json(response, 404, { ok: false, error: "not-found" }, cors);
  }
}

async function handleLink(runtime: CoyoteRuntime, route: string): Promise<Record<string, unknown>> {
  if (route === "/api/dglab/disconnect") {
    await runtime.disconnectLink();
  } else {
    // connect() is a no-op when the socket is already live.
    await runtime.connectLink();
  }
  return runtime.getState();
}

function streamEvents(
  runtime: CoyoteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  cors: Record<string, string>
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...cors
  });
  // A comment line first: it flushes the headers, so the panel's EventSource
  // is open even when the next thing that happens is nothing.
  response.write(": open\n\n");
  const send = (event: CoyoteEvent): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const off = runtime.bus.onEvent(send);
  const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
  ping.unref?.();
  const stop = (): void => {
    clearInterval(ping);
    off();
  };
  request.on("close", stop);
  response.on("close", stop);
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
  cors: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...cors
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("body too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readNumber(body: unknown, key: string): number | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readBoolean(body: unknown, key: string, fallback: boolean): boolean {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function readChannel(body: unknown): "A" | "B" {
  const value = (body as Record<string, unknown> | undefined)?.channel;
  return value === "B" ? "B" : "A";
}
