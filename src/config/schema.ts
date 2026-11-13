import { z } from "zod";

const channelSchema = z.enum(["A", "B"]);
// Coefficients may amplify as well as attenuate; SafetyGate still clamps the result.
const coefficientSchema = z.coerce.number().min(0).max(2).transform((value) => Math.round(value * 100) / 100);
const intensitySchema = z.coerce.number().min(0).max(1).transform((value) => Math.round(value * 100) / 100);
// An empty string or null means "the built-in default", which is what the
// console sends when that row's waveform picker is left on 默认.
const waveformIdSchema = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.string().trim().min(1).optional()
);
const objectWithDefaults = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess((value) => value ?? {}, z.object(shape));

/**
 * Settings for the plugin.
 *
 * There is no provider/proxy block any more: magpie is the gateway, and this
 * plugin only listens to it through `magpie.hooks`. What is left is the part
 * that talks to the device.
 */
export const configSchema = z.object({
  console: objectWithDefaults({
    // The control panel's service. Loopback only: the panel is a local tool,
    // and the page reaches it either over this computer or through magpie web.
    host: z.string().default("127.0.0.1"),
    // 0 lets the OS pick one; the console reports the port it really got.
    port: z.coerce.number().int().min(0).max(65535).default(8787)
  }),
  privacy: objectWithDefaults({
    recent_event_limit: z.coerce.number().int().min(1).max(5000).default(200)
  }),
  safety: objectWithDefaults({
    dry_run: z.boolean().default(true),
    armed: z.boolean().default(false),
    channel_limits: objectWithDefaults({
      A: z.coerce.number().int().min(0).max(100).default(15),
      B: z.coerce.number().int().min(0).max(100).default(10)
    }),
    max_continuous_output_ms: z.coerce.number().int().min(1).max(30_000).default(3000),
    max_events_per_minute: z.coerce.number().int().min(1).max(600).default(120),
    panic_zero_on_exit: z.boolean().default(true),
    // Largest intensity increase a single plan may apply per channel.
    max_intensity_step: z.coerce.number().min(0.01).max(1).default(0.2),
    // Minimum spacing between discrete (non-continuous) plans on one channel.
    min_interval_ms: z.coerce.number().int().min(0).max(10_000).default(150),
    // Auto-disarm ceilings; 0 disables the corresponding check.
    max_session_ms: z.coerce.number().int().min(0).max(6 * 3_600_000).default(1_800_000),
    idle_disarm_ms: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
    respect_device_soft_limit: z.boolean().default(true)
  }),
  policy: objectWithDefaults({
    request_started: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(120),
      waveform_id: waveformIdSchema
    }),
    response_started: objectWithDefaults({
      channel: channelSchema.default("B"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(120),
      waveform_id: waveformIdSchema
    }),
    // While a request is in flight the plugin has no per-chunk view (magpie's
    // gateway hooks fire at the start and at the end only), so this is driven
    // by the plugin's own ticker and the reply's measured duration.
    response_chunk: objectWithDefaults({
      channel: channelSchema.default("B"),
      coefficient: coefficientSchema.default(1),
      micro_intensity: intensitySchema.default(0.1),
      duration_ms: z.coerce.number().int().positive().default(2000),
      waveform_id: waveformIdSchema,
      tick_ms: z.coerce.number().int().min(100).max(10_000).default(900)
    }),
    response_tool_call: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(160),
      waveform_id: waveformIdSchema
    }),
    response_error_status: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(220),
      waveform_id: waveformIdSchema
    }),
    response_done: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(180),
      token_target: z.coerce.number().int().min(1).default(1200),
      waveform_id: waveformIdSchema
    })
  }),
  dglab: objectWithDefaults({
    enabled: z.boolean().default(true),
    socket_url: z.string().default("ws://127.0.0.1:9999"),
    qr_host: z.string().default("auto"),
    qr_port: z.coerce.number().int().min(0).max(65535).default(9999),
    // The built-in Socket V2 relay has to be reachable from the phone, so it
    // binds wider than the console does.
    relay_bind_host: z.string().default("0.0.0.0"),
    // The official app cannot carry a secret, so the relay refuses public
    // origins instead of asking for a token pairing cannot present.
    relay_allow_public: z.boolean().default(false),
    relay_max_clients: z.coerce.number().int().min(1).max(64).default(8)
  })
});

export type AppConfig = z.infer<typeof configSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type SafetyConfig = AppConfig["safety"];
export type PolicyConfig = AppConfig["policy"];
export type DglabConfig = AppConfig["dglab"];
export type ConsoleConfig = AppConfig["console"];
