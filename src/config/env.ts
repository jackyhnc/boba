import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1).default("postgresql://boba:boba@localhost:5432/boba?schema=public"),

  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_PHONE_NUMBER: z.string().optional().default(""),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional().default(""),

  // When true (default in dev), outbound SMS is logged instead of sent.
  // Set to "false" once real credentials are in place.
  TWILIO_DRY_RUN: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  // When true, inbound webhook signature verification is enforced even if
  // creds look incomplete. Default false so dev/ngrok testing isn't blocked
  // before the user provisions Twilio; flip to true in production.
  TWILIO_REQUIRE_SIGNATURE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  PUBLIC_WEBHOOK_BASE_URL: z.string().url().default("http://localhost:3000"),

  AI_SEEDING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  // Closed-beta invite code gate. When true (default), the onboarding
  // state machine begins by asking for a redeemable InviteCode.
  INVITES_REQUIRED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  // Bearer token (X-Admin-Token header) required by /admin/* routes. When
  // empty, admin routes return 503 (disabled).
  ADMIN_TOKEN: z.string().optional().default(""),

  // Auto-run the daily-match scheduler in-process. When false, only the
  // /admin/run-daily-match endpoint triggers a run. Cron is in UTC.
  SCHEDULER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  SCHEDULER_CRON: z.string().default("0 21 * * *"), // 9pm UTC = 5pm ET

  // Sentry error reporting. No-op when DSN empty.
  SENTRY_DSN: z.string().optional().default(""),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// Reset for tests
export function _resetEnvCacheForTests(): void {
  cached = null;
}
