import { randomUUID } from "node:crypto";
import { currentRuntime, getRuntime } from "./src/host/runtime.ts";
import type { PluginOptions } from "./src/config/settings.ts";

/**
 * magpie gateway hooks.
 *
 * These run in the plugin host (Bun), once per agent request: `onRequest`
 * before it is routed, `onResponse` after output finished. Neither is allowed
 * to change the request or the reply, and both must return quickly — the hook's
 * budget is `gatewayTimeoutMs` (see `magpie.options` in package.json), one
 * second by default. Everything that touches the device is therefore
 * fire-and-forget; the runtime serializes and gates it.
 */

/** The parts of magpie's hook context this plugin reads. */
interface HookContext {
  protocol?: string;
  model?: string;
  stream?: boolean;
  path?: string;
  agent?: string;
  session?: string;
  options?: Record<string, unknown>;
  state?: Record<string, unknown>;
  success?: boolean;
  signal?: AbortSignal;
}

/** How long a hook waits for the runtime if it is still starting. */
const READY_WAIT_MS = 400;

/**
 * The runtime, waiting a little for it if the entry is still bringing it up.
 * `ctx.options` is the plugin's own options (plugins.json), so a runtime that
 * has to be started from here still gets the port and socket the user chose.
 */
async function runtimeInTime(options: PluginOptions) {
  const ready = currentRuntime();
  if (ready) {
    return ready;
  }
  const timeout = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), READY_WAIT_MS);
    timer.unref?.();
  });
  // A runtime that failed to start is the entry's to report; a hook that logs
  // it again would say the same thing once per request.
  return await Promise.race([getRuntime(options), timeout]);
}

export async function onRequest(body: unknown, ctx: HookContext): Promise<undefined> {
  try {
    const runtime = await runtimeInTime((ctx.options ?? {}) as PluginOptions);
    if (!runtime) {
      return undefined;
    }
    const id = randomUUID();
    if (ctx.state) {
      // The same ctx (and so the same state) comes back to onResponse for this
      // request, which is how the two halves are tied together.
      ctx.state.coyotecoder = id;
    }
    runtime.beginRequest({
      id,
      model: ctx.model,
      agent: ctx.agent,
      session: ctx.session,
      protocol: ctx.protocol,
      path: ctx.path,
      stream: ctx.stream === true
    });
  } catch (error) {
    console.warn(`coyotecoder: onRequest skipped: ${String(error)}`);
  }
  // undefined keeps the request exactly as the agent sent it.
  return undefined;
}

export async function onResponse(reply: unknown, ctx: HookContext): Promise<undefined> {
  try {
    const runtime = currentRuntime();
    const id = typeof ctx.state?.coyotecoder === "string" ? ctx.state.coyotecoder : undefined;
    if (!runtime || !id) {
      return undefined;
    }
    runtime.endRequest(id, summarizeReply(reply, ctx));
  } catch (error) {
    console.warn(`coyotecoder: onResponse skipped: ${String(error)}`);
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Reads what the reply says about itself. Anthropic Messages, Open Responses
 * and Chat Completions describe usage and tool calls differently, so all three
 * shapes are looked at. Streamed replies arrive here as `null`: magpie's hook
 * gets a completion notice, not the assembled body.
 */
export function summarizeReply(reply: unknown, ctx: HookContext): {
  success: boolean;
  status?: number;
  outputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  finishReason?: string;
} {
  const body = isRecord(reply) ? reply : undefined;
  const usage = isRecord(body?.usage) ? body.usage : undefined;
  const outputTokens =
    toNumber(usage?.output_tokens) ?? toNumber(usage?.outputTokens) ?? toNumber(usage?.completion_tokens);
  const totalTokens = toNumber(usage?.total_tokens) ?? toNumber(usage?.totalTokens);
  const error = isRecord(body?.error) ? body.error : undefined;
  const success = ctx.success === true && error === undefined;
  const status =
    toNumber(error?.status) ?? toNumber(error?.code) ?? toNumber(body?.status) ?? (success ? 200 : undefined);
  const finishReason =
    toText(body?.stop_reason) ?? toText(body?.finish_reason) ?? toText(body?.status) ?? undefined;
  return { success, status, outputTokens, totalTokens, toolCalls: countToolCalls(body), finishReason };
}

function countToolCalls(body: Record<string, unknown> | undefined): number {
  if (!body) {
    return 0;
  }
  // Chat Completions
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : undefined;
    const calls = message?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      return calls.length;
    }
  }
  // Anthropic Messages
  const content = Array.isArray(body.content) ? body.content : [];
  const anthropicCalls = content.filter((block) => isRecord(block) && block.type === "tool_use").length;
  if (anthropicCalls > 0) {
    return anthropicCalls;
  }
  // Open Responses
  const output = Array.isArray(body.output) ? body.output : [];
  return output.filter((item) => isRecord(item) && item.type === "function_call").length;
}
