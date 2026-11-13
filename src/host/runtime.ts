import { DglabController } from "../dglab/controller.ts";
import { shouldStartLocalRelay, startLocalDglabRelay, type DglabRelayServer } from "../dglab/relay.ts";
import { DglabSink } from "../dglab/sink.ts";
import { WaveformRegistry } from "../dglab/waves.ts";
import { EventBus } from "../events/bus.ts";
import { DryRunSink } from "../shock/dryRunSink.ts";
import { ShockEngine } from "../shock/engine.ts";
import { ShockPlanStore } from "../shock/planStore.ts";
import { ShockPolicy } from "../shock/policy.ts";
import { SafetyGate } from "../shock/safety.ts";
import type { ShockSink, ShockPlan } from "../shock/types.ts";
import type { AppConfig, Channel } from "../config/schema.ts";
import { applyOptions, loadSettings, patchSettings, type PluginOptions } from "../config/settings.ts";
import { startConsoleServer, type ConsoleServer } from "./console.ts";

/** What magpie's gateway hook knows when a request starts. */
export interface RequestInfo {
  id: string;
  model?: string;
  agent?: string;
  session?: string;
  protocol?: string;
  stream: boolean;
  path?: string;
}

/** What it knows when output finished. */
export interface RequestOutcome {
  success: boolean;
  status?: number;
  outputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  finishReason?: string;
}

/**
 * How long one request may keep the "working" feedback going. magpie's gateway
 * hooks fire at the start and at the end of a request only, so the in-between
 * pulses come from this plugin's own ticker; the cap keeps a request that is
 * never reported finished from holding output forever.
 */
const MAX_STREAM_TICKS = 20;

interface InFlight {
  info: RequestInfo;
  startedAt: number;
  ticker?: ReturnType<typeof setInterval>;
  ticks: number;
}

export class CoyoteRuntime {
  config: AppConfig;
  readonly bus: EventBus;
  readonly safety: SafetyGate;
  readonly policy: ShockPolicy;
  readonly waveforms: WaveformRegistry;
  readonly shockPlans: ShockPlanStore;
  private readonly engine: ShockEngine;
  private readonly dglab?: DglabController;
  private relay?: DglabRelayServer;
  private server?: ConsoleServer;
  private readonly inFlight = new Map<string, InFlight>();
  private closed = false;

  private constructor(config: AppConfig) {
    this.config = config;
    this.bus = new EventBus(config.privacy.recent_event_limit);
    this.safety = new SafetyGate(config.safety);
    this.policy = new ShockPolicy(config.policy);
    this.waveforms = new WaveformRegistry();
    this.shockPlans = new ShockPlanStore(config.privacy.recent_event_limit);
    this.dglab = config.dglab.enabled ? new DglabController(config.dglab, this.bus) : undefined;
    const sink: ShockSink = this.dglab ? new DglabSink(this.dglab, this.waveforms) : new DryRunSink();
    this.engine = new ShockEngine(this.bus, this.policy, this.safety, sink, this.shockPlans);

    // An armed session must not outlive the link that carries its output, and
    // an auto-disarm has to reach the hardware, not just flip a flag.
    this.safety.onAutoDisarm((reason) => {
      this.log("warn", `auto disarm: ${reason}`);
      this.bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
      void this.emergencyZero();
    });

    this.bus.onEvent((event) => {
      if (event.type === "dglab.disconnected") {
        // The soft limits belonged to the device that just went away.
        this.safety.setDeviceSoftLimits(undefined);
        this.safety.notifyLinkLost();
        return;
      }
      if (event.type === "dglab.strength_report") {
        const strengths = this.dglab?.getStatus().strengths;
        this.safety.setDeviceSoftLimits(
          strengths ? { A: strengths.softLimitA, B: strengths.softLimitB } : undefined
        );
      }
    });
  }

  static async create(options: PluginOptions = {}): Promise<CoyoteRuntime> {
    const runtime = new CoyoteRuntime(applyOptions(loadSettings(), options));
    await runtime.start();
    return runtime;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    // magpie turns whatever a plugin writes into `plugin: …` lines.
    const line = `coyotecoder: ${message}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  private async start(): Promise<void> {
    await this.openTransports();
    try {
      this.server = await startConsoleServer(this);
      this.log("info", `control panel on http://${this.server.address.host}:${this.server.address.port}/`);
    } catch (error) {
      // The panel is one way in, not the way this plugin works: hooks and the
      // device link must keep going even when its port is taken (a host that
      // is being replaced still holds it for a moment).
      this.log("warn", `control panel did not start on ${this.config.console.host}:${this.config.console.port}: ${String(error)}`);
    }
  }

  private async openTransports(): Promise<void> {
    if (!this.config.dglab.enabled) {
      return;
    }
    try {
      this.relay = await this.openRelay();
    } catch (error) {
      this.log("warn", `relay did not start on ${this.config.dglab.socket_url}: ${String(error)}`);
    }
    // Not awaited: the plugin has to be up before magpie serves the panel,
    // and the controller reconnects by itself until the device answers.
    void this.dglab?.connect().catch((error: unknown) => {
      this.log("warn", `no DG-LAB link yet: ${String(error)}`);
    });
  }

  /**
   * Starts the built-in Socket V2 relay. A restarting plugin host can leave the
   * previous relay's address in use for a moment, and `startLocalDglabRelay`
   * treats that as "someone else has it" — so give it a few tries before
   * believing that, otherwise the panel has no relay and the controller only
   * sees ECONNREFUSED.
   */
  private async openRelay(): Promise<DglabRelayServer | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const relay = await startLocalDglabRelay(this.config.dglab);
      if (relay) {
        return relay;
      }
      if (!shouldStartLocalRelay(this.config.dglab.socket_url)) {
        return undefined;
      }
      if (attempt < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    }
    this.log("warn", `another relay holds ${this.config.dglab.socket_url}; using it`);
    return undefined;
  }

  /** Opens the DG-LAB link again (the panel's "reconnect"). */
  async connectLink(): Promise<void> {
    await this.dglab?.connect().catch((error: unknown) => {
      this.log("warn", `no DG-LAB link yet: ${String(error)}`);
    });
  }

  /** Recalls queued pulses and closes the link, keeping the relay up. */
  async disconnectLink(): Promise<void> {
    try {
      this.relay?.cancelAllPulses();
    } catch {
      // nothing queued
    }
    await this.dglab?.disconnect().catch(() => undefined);
  }

  /** Restarts what a settings change cannot adjust in place. */
  async reload(): Promise<void> {
    await this.stopTransports();
    await this.openTransports();
  }

  private async stopTransports(): Promise<void> {
    try {
      this.relay?.cancelAllPulses();
    } catch {
      // A relay that never finished starting has nothing to recall.
    }
    await this.dglab?.disconnect().catch(() => undefined);
    await this.relay?.close().catch(() => undefined);
    this.relay = undefined;
  }

  get consoleAddress(): { host: string; port: number } | undefined {
    return this.server?.address;
  }

  /** This launch's page key: every panel /api call has to carry it. */
  get consoleKey(): string | undefined {
    return this.server?.key;
  }

  /**
   * Applies a settings patch from the console. Safety and policy limits take
   * effect at once; the DG-LAB link is reopened only when its own settings
   * changed, because a socket cannot be adjusted in place.
   */
  applyPatch(patch: unknown): { config: AppConfig; reloaded: boolean } {
    const before = this.config;
    const next = patchSettings(before, patch);
    const dryRunChanged = before.safety.dry_run !== next.safety.dry_run;
    this.config = next;

    if (dryRunChanged) {
      this.safety.setDryRun(next.safety.dry_run);
    }
    this.safety.updateSettings({
      channelLimits: next.safety.channel_limits,
      maxContinuousOutputMs: next.safety.max_continuous_output_ms,
      maxEventsPerMinute: next.safety.max_events_per_minute,
      maxIntensityStep: next.safety.max_intensity_step,
      minIntervalMs: next.safety.min_interval_ms,
      maxSessionMs: next.safety.max_session_ms,
      idleDisarmMs: next.safety.idle_disarm_ms,
      respectDeviceSoftLimit: next.safety.respect_device_soft_limit
    });
    this.policy.updateSettings({
      requestStarted: policyPatch(next.policy.request_started),
      responseStarted: policyPatch(next.policy.response_started),
      responseDone: { ...policyPatch(next.policy.response_done), tokenTarget: next.policy.response_done.token_target },
      responseToolCall: policyPatch(next.policy.response_tool_call),
      responseErrorStatus: policyPatch(next.policy.response_error_status),
      responseChunk: {
        channel: next.policy.response_chunk.channel,
        coefficient: next.policy.response_chunk.coefficient,
        microIntensity: next.policy.response_chunk.micro_intensity,
        durationMs: next.policy.response_chunk.duration_ms,
        waveformId: next.policy.response_chunk.waveform_id ?? null
      }
    });

    if (before.dglab.enabled !== next.dglab.enabled) {
      // The sink is chosen when the runtime is built: switching between the
      // real device and dry run needs the plugin reloaded, not a live patch.
      this.log("warn", `dglab.enabled changed to ${next.dglab.enabled}: reopen the plugin for it to take effect`);
    }
    const dglabChanged =
      before.dglab.socket_url !== next.dglab.socket_url ||
      before.dglab.relay_bind_host !== next.dglab.relay_bind_host ||
      before.dglab.relay_allow_public !== next.dglab.relay_allow_public ||
      before.dglab.relay_max_clients !== next.dglab.relay_max_clients;
    if (dglabChanged) {
      this.log("info", "DG-LAB settings changed, reopening the link");
      void this.reload();
    }
    if (before.console.port !== next.console.port) {
      this.log("warn", `console port changed to ${next.console.port}: reopen the plugin to move the service`);
    }
    return { config: next, reloaded: dglabChanged };
  }

  arm(): void {
    this.safety.arm();
    this.bus.emit({ type: "safety.armed", timestamp: Date.now() });
  }

  async disarm(): Promise<boolean> {
    this.safety.disarm();
    this.bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
    // Disarming blocks future plans; it does not unlatch what the device holds.
    return this.emergencyZero();
  }

  async panic(): Promise<{ zeroed: boolean; plans: ShockPlan[] }> {
    const plans = this.safety.panic();
    this.bus.emit({ type: "safety.panic", timestamp: Date.now() });
    // Zero straight away instead of waiting for the event to travel through
    // the engine: panic must not depend on that path being healthy.
    const zeroed = await this.emergencyZero();
    return { zeroed, plans };
  }

  setDryRun(enabled: boolean): void {
    this.safety.setDryRun(enabled);
    // Dry run never covers the de-escalation path, so turning it on recalls
    // whatever the device still holds.
    if (enabled) {
      void this.emergencyZero();
    }
  }

  async emergencyZero(): Promise<boolean> {
    try {
      this.relay?.cancelAllPulses();
    } catch {
      // nothing queued
    }
    if (!this.dglab) {
      return false;
    }
    try {
      return await this.dglab.zeroAll();
    } catch (error) {
      this.log("error", `zero failed: ${String(error)}`);
      return false;
    }
  }

  /** A manual pulse from the console: still gated, still serialized. */
  async testPulse(channel: Channel, intensity: number, durationMs: number, waveId?: string): Promise<void> {
    await this.engine.sendGatedPlan({
      kind: "shock.plan",
      channel,
      intensity: Math.min(1, Math.max(0, intensity)),
      durationMs: Math.max(50, Math.round(durationMs)),
      reason: "console.test",
      waveId
    });
  }

  // ---------------------------------------------------------------- gateway

  /**
   * `onRequest`: an agent request started. magpie hands us the model, the agent
   * and the stream flag but no chunks, so the "working" feedback is a ticker
   * `endRequest` stops.
   */
  beginRequest(info: RequestInfo): void {
    this.forgetRequest(info.id);
    const entry: InFlight = { info, startedAt: Date.now(), ticks: 0 };
    this.inFlight.set(info.id, entry);
    this.bus.emit({ type: "request.started", timestamp: entry.startedAt, requestId: info.id, model: info.model });
    this.bus.emit({ type: "response.started", timestamp: entry.startedAt, requestId: info.id, model: info.model });
    const tickMs = Math.max(200, this.config.policy.response_chunk.tick_ms);
    entry.ticker = setInterval(() => this.tick(info.id), tickMs);
    entry.ticker.unref?.();
  }

  private tick(id: string): void {
    const entry = this.inFlight.get(id);
    if (!entry) {
      return;
    }
    if (entry.ticks >= MAX_STREAM_TICKS) {
      this.stopTicker(entry);
      return;
    }
    entry.ticks += 1;
    const elapsedMs = Math.max(1, Date.now() - entry.startedAt);
    // No chunk data is available through gateway hooks, so the ramp is
    // time-based: what a model writing at 80 characters a second looks like.
    const cumulativeChars = Math.min(900, Math.round((elapsedMs / 1000) * 80));
    this.bus.emit({
      type: "response.chunk",
      timestamp: Date.now(),
      requestId: id,
      bytes: cumulativeChars,
      chars: cumulativeChars,
      deltaMs: elapsedMs,
      cumulativeChars,
      streamRateCharsPerSec: Math.round((cumulativeChars / elapsedMs) * 1000)
    });
  }

  private stopTicker(entry: InFlight): void {
    if (entry.ticker) {
      clearInterval(entry.ticker);
      entry.ticker = undefined;
    }
  }

  private forgetRequest(id: string): void {
    const entry = this.inFlight.get(id);
    if (entry) {
      this.stopTicker(entry);
      this.inFlight.delete(id);
    }
  }

  /** `onResponse`: output finished, or the request failed. */
  endRequest(id: string, outcome: RequestOutcome & { silent?: boolean }): void {
    const entry = this.inFlight.get(id);
    if (!entry) {
      return;
    }
    this.forgetRequest(id);
    if (outcome.silent) {
      return;
    }
    const durationMs = Date.now() - entry.startedAt;
    if (!outcome.success) {
      this.bus.emit({
        type: "response.error",
        timestamp: Date.now(),
        requestId: id,
        message: `request failed with status ${outcome.status ?? "unknown"}`
      });
      if (outcome.status !== undefined && outcome.status >= 400) {
        this.bus.emit({
          type: "response.error_status",
          timestamp: Date.now(),
          requestId: id,
          statusCode: outcome.status,
          durationMs
        });
      }
      return;
    }
    if (outcome.toolCalls && outcome.toolCalls > 0) {
      this.bus.emit({
        type: "response.tool_call",
        timestamp: Date.now(),
        requestId: id,
        toolCallCount: outcome.toolCalls
      });
    }
    this.bus.emit({
      type: "response.done",
      timestamp: Date.now(),
      requestId: id,
      statusCode: outcome.status ?? 200,
      durationMs,
      outputTokens: outcome.outputTokens,
      totalTokens: outcome.totalTokens,
      finishReason: outcome.finishReason
    });
  }

  // ---------------------------------------------------------------- console

  getState(): Record<string, unknown> {
    return {
      ok: true,
      config: this.config,
      safety: this.safety.getStatus(),
      dglab: this.dglab
        ? { ...this.dglab.getStatus(), link: true, relay: this.relay?.getStats() ?? null }
        : { enabled: this.config.dglab.enabled, link: false, relay: this.relay?.getStats() ?? null },
      events: this.bus.getRecent(),
      plans: this.shockPlans.getRecent(),
      console: this.server?.address ?? null
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const entry of this.inFlight.values()) {
      this.stopTicker(entry);
    }
    this.inFlight.clear();
    // Order matters: stop taking plans, let queued sends settle, recall queued
    // forwards, zero the device, then drop the transports.
    this.safety.disarm();
    await this.engine.drain().catch(() => undefined);
    if (this.config.safety.panic_zero_on_exit) {
      await this.emergencyZero();
    }
    this.safety.dispose();
    await this.server?.close().catch(() => undefined);
    await this.stopTransports();
  }
}

let current: CoyoteRuntime | undefined;

/** The runtime, once it is up; undefined while it is still starting. */
export function currentRuntime(): CoyoteRuntime | undefined {
  return current;
}

function policyPatch(feedback: {
  channel: Channel;
  coefficient: number;
  duration_ms: number;
  waveform_id?: string;
}): { channel: Channel; coefficient: number; durationMs: number; waveformId: string | null } {
  return {
    channel: feedback.channel,
    coefficient: feedback.coefficient,
    durationMs: feedback.duration_ms,
    waveformId: feedback.waveform_id ?? null
  };
}

let shared: Promise<CoyoteRuntime> | undefined;

/** The one runtime of this plugin host: the entry and the hooks share it. */
export function getRuntime(options: PluginOptions = {}): Promise<CoyoteRuntime> {
  // The promise is kept even when it failed: a plugin that cannot start would
  // otherwise build a fresh runtime on every request, relay and all.
  shared ??= CoyoteRuntime.create(options).then((runtime) => {
    current = runtime;
    return runtime;
  });
  return shared;
}
