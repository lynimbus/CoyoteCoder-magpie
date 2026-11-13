import { getRuntime } from "./src/host/runtime.ts";
import type { PluginOptions } from "./src/config/settings.ts";

/**
 * The plugin's host part.
 *
 * magpie calls this once when the plugin is loaded. It brings up the DG-LAB
 * link, the built-in Socket V2 relay and the control panel's local service.
 * What it returns is deliberately empty: this plugin answers no agent request
 * and serves no model — it listens to magpie's gateway through `hooks.ts`
 * (`magpie.hooks`) and turns what agents do into device feedback.
 */
export const CoyoteCoder = async (_input: unknown, options: PluginOptions = {}): Promise<Record<string, never>> => {
  try {
    await getRuntime(options);
  } catch (error) {
    // A plugin that throws here is left out of the host entirely, and then its
    // gateway hooks never see a request. Failing loudly in the log and staying
    // loaded keeps the panel reachable so the cause can be fixed in place.
    console.error(`coyotecoder: runtime did not start: ${String(error)}`);
  }
  return {};
};
