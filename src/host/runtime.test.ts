import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoyoteEvent } from "../events/types.ts";
import { CoyoteRuntime } from "./runtime.ts";

let dir: string;
let runtime: CoyoteRuntime | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "coyotecoder-"));
  process.env.COYOTECODER_HOME = dir;
  // No DG-LAB link in tests: the relay would bind a port and reconnect forever.
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ console: { port: 0 }, dglab: { enabled: false } })
  );
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  delete process.env.COYOTECODER_HOME;
});

function collect(rt: CoyoteRuntime): CoyoteEvent[] {
  const seen: CoyoteEvent[] = [];
  rt.bus.onEvent((event) => seen.push(event));
  return seen;
}

describe("CoyoteRuntime", () => {
  it("turns a request's start and end into gateway events", async () => {
    runtime = await CoyoteRuntime.create();
    const seen = collect(runtime);

    runtime.beginRequest({ id: "req_1", model: "gpt-5", stream: true });
    runtime.endRequest("req_1", { success: true, outputTokens: 600, toolCalls: 2 });

    expect(seen.map((event) => event.type)).toEqual([
      "request.started",
      "response.started",
      "response.tool_call",
      "response.done"
    ]);
    expect(seen.at(-1)).toMatchObject({ requestId: "req_1", outputTokens: 600, statusCode: 200 });
  });

  it("reports a failed request as an error with its status", async () => {
    runtime = await CoyoteRuntime.create();
    const seen = collect(runtime);

    runtime.beginRequest({ id: "req_2", model: "gpt-5", stream: false });
    runtime.endRequest("req_2", { success: false, status: 429 });

    expect(seen.map((event) => event.type)).toContain("response.error");
    expect(seen.map((event) => event.type)).toContain("response.error_status");
  });

  it("ignores an end for a request it never saw", async () => {
    runtime = await CoyoteRuntime.create();
    const seen = collect(runtime);

    runtime.endRequest("nobody", { success: true });

    expect(seen).toEqual([]);
  });

  it("keeps panic latched until the gate is armed again", async () => {
    runtime = await CoyoteRuntime.create();
    runtime.arm();
    expect(runtime.safety.getStatus().armed).toBe(true);

    const result = await runtime.panic();
    expect(result.zeroed).toBe(false); // no device in tests
    expect(runtime.safety.getStatus()).toMatchObject({ armed: false, panic: true });

    runtime.arm();
    expect(runtime.safety.getStatus()).toMatchObject({ armed: true, panic: false });
  });

  it("serves the control panel API", async () => {
    runtime = await CoyoteRuntime.create();
    const address = runtime.consoleAddress;
    expect(address?.port).toBeGreaterThan(0);
    const base = `http://${address?.host}:${address?.port}`;
    const key = runtime.consoleKey ?? "";
    expect(key.length).toBeGreaterThan(16);
    const call = (route: string, init: RequestInit = {}, useKey = key): Promise<Response> =>
      fetch(`${base}${route}`, {
        ...init,
        headers: { "x-coyotecoder-key": useKey, ...(init.headers as Record<string, string> | undefined) }
      });

    const state = (await (await call("/api/state")).json()) as Record<string, unknown>;
    expect(state.ok).toBe(true);
    expect((state.safety as Record<string, unknown>).armed).toBe(false);

    // The panel is framed sandboxed, so anything could embed it: the key is
    // what keeps another page from moving the device.
    expect((await call("/api/state", {}, "")).status).toBe(401);
    expect((await call("/api/state", {}, "not-the-key")).status).toBe(401);

    // EventSource cannot set headers, so the key travels in the query too.
    const viaQuery = await fetch(`${base}/api/state?key=${encodeURIComponent(key)}`);
    expect(viaQuery.status).toBe(200);

    const armed = (await (await call("/api/arm", { method: "POST" })).json()) as Record<string, unknown>;
    expect((armed.safety as Record<string, unknown>).armed).toBe(true);

    const dry = (await (
      await call("/api/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false })
      })
    ).json()) as Record<string, unknown>;
    expect((dry.safety as Record<string, unknown>).dryRun).toBe(false);
  });

  it("accepts a waveform reset and rejects nonsense", async () => {
    runtime = await CoyoteRuntime.create();

    // The console sends null for "默认" on a row's waveform picker.
    expect(() => runtime!.applyPatch({ policy: { response_done: { waveform_id: null } } })).not.toThrow();
    expect(runtime.config.policy.response_done.waveform_id).toBeUndefined();

    expect(() => runtime!.applyPatch({ safety: { max_events_per_minute: "nonsense" } })).toThrow();
  });

  it("saves limits but never saves an armed session", async () => {
    runtime = await CoyoteRuntime.create();
    runtime.arm();

    runtime.applyPatch({ safety: { channel_limits: { A: 20, B: 3 } } });

    const stored = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as {
      safety: { armed: boolean; channel_limits: { A: number; B: number } };
    };
    expect(stored.safety.channel_limits).toEqual({ A: 20, B: 3 });
    expect(stored.safety.armed).toBe(false);
    // ...while the running gate keeps the session it was given.
    expect(runtime.safety.getStatus().armed).toBe(true);
  });
});
