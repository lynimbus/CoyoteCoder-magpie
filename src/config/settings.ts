import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configSchema, type AppConfig } from "./schema.ts";

/**
 * The plugin's own folder for state. magpie runs the plugin host with its
 * config folder as the working directory (`~/.config/magpie`), so this lands
 * next to `plugins.json` rather than inside the package, which npm owns.
 */
export function dataDir(): string {
  const override = process.env.COYOTECODER_HOME?.trim();
  return override && override.length > 0 ? override : path.join(process.cwd(), "plugin-work", "coyotecoder");
}

export function settingsPath(): string {
  return path.join(dataDir(), "settings.json");
}

export interface PluginOptions {
  port?: unknown;
  socketUrl?: unknown;
  relayBindHost?: unknown;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/** Options set in magpie's Plugins page (plugins.json) win over the file. */
export function applyOptions(config: AppConfig, options: PluginOptions | undefined): AppConfig {
  if (!options) {
    return config;
  }
  const patch: Record<string, unknown> = {};
  const port = Number(options.port);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    patch.console = { port };
  }
  if (typeof options.socketUrl === "string" && options.socketUrl.trim() !== "") {
    patch.dglab = { socket_url: options.socketUrl.trim() };
  }
  if (typeof options.relayBindHost === "string" && options.relayBindHost.trim() !== "") {
    patch.dglab = { ...(patch.dglab as Record<string, unknown> | undefined), relay_bind_host: options.relayBindHost.trim() };
  }
  return configSchema.parse(deepMerge(config as unknown as Record<string, unknown>, patch));
}

export function normalize(raw: unknown): AppConfig {
  return configSchema.parse(isRecord(raw) ? raw : {});
}

/** Reads `settings.json`, falling back to the built-in defaults. */
export function loadSettings(): AppConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    raw = {};
  }
  return normalize(raw);
}

/**
 * Writes settings back. `armed` is deliberately never stored: an armed session
 * must not survive the process that held the device link, or a restart would
 * resume output nobody asked for.
 */
export function saveSettings(config: AppConfig): AppConfig {
  const stored = structuredClone(config) as AppConfig;
  stored.safety.armed = false;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`coyotecoder: could not save settings: ${String(error)}`);
  }
  return stored;
}

/** Applies a partial patch from the console, validates it, and persists it. */
export function patchSettings(current: AppConfig, patch: unknown): AppConfig {
  if (!isRecord(patch)) {
    return current;
  }
  const next = configSchema.parse(deepMerge(current as unknown as Record<string, unknown>, patch));
  return saveSettings(next);
}
