// Thin outbound Twilio SMS client.
//
// Uses raw `fetch` against the Twilio REST API rather than pulling the
// Node SDK (one less dependency, and the SMS API surface we use is tiny).
//
// Honours `TWILIO_DRY_RUN`: when true (default in dev) the call is
// logged and a synthetic SID is returned instead of hitting Twilio.
// This lets every code path that emits an outbound message run
// end-to-end in tests and locally without credentials.

import type { Logger } from "pino";
import type { Env } from "../config/env.js";

const TWILIO_BASE_URL = "https://api.twilio.com/2010-04-01";

export interface SendSmsInput {
  /** Destination phone in E.164 (e.g. "+15551234567"). */
  to: string;
  /** Message body. Will be split client-side by Twilio if >1600 chars. */
  body: string;
}

export interface SendSmsResult {
  /** Twilio message SID (`SM...` or `MM...`). Synthetic in dry-run mode. */
  sid: string;
  /** True if the call was short-circuited by `TWILIO_DRY_RUN`. */
  dryRun: boolean;
  /** HTTP status from Twilio (200/201 expected). Absent in dry-run. */
  status?: number;
}

export interface TwilioClient {
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
}

export interface TwilioClientDeps {
  env: Pick<
    Env,
    | "TWILIO_ACCOUNT_SID"
    | "TWILIO_AUTH_TOKEN"
    | "TWILIO_PHONE_NUMBER"
    | "TWILIO_MESSAGING_SERVICE_SID"
    | "TWILIO_DRY_RUN"
  >;
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
  /** Injectable fetch for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function createTwilioClient(deps: TwilioClientDeps): TwilioClient {
  const { env, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    async sendSms({ to, body }): Promise<SendSmsResult> {
      if (env.TWILIO_DRY_RUN) {
        const sid = `DRYRUN-${cryptoRandomId()}`;
        logger.info({ to, body, sid, dryRun: true }, "twilio.sendSms (dry run)");
        return { sid, dryRun: true };
      }

      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new Error(
          "Twilio credentials missing — set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN or TWILIO_DRY_RUN=true",
        );
      }
      if (!env.TWILIO_PHONE_NUMBER && !env.TWILIO_MESSAGING_SERVICE_SID) {
        throw new Error(
          "Twilio sender missing — set TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID",
        );
      }

      const form = new URLSearchParams();
      form.set("To", to);
      form.set("Body", body);
      if (env.TWILIO_MESSAGING_SERVICE_SID) {
        form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
      } else {
        form.set("From", env.TWILIO_PHONE_NUMBER);
      }

      const url = `${TWILIO_BASE_URL}/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`;
      const auth = Buffer.from(
        `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
        "utf8",
      ).toString("base64");

      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      });

      if (!res.ok) {
        const text = await safeReadText(res);
        logger.error({ status: res.status, to, body, response: text }, "twilio.sendSms failed");
        throw new Error(`Twilio sendSms failed: ${res.status} ${text}`);
      }

      const json = (await res.json()) as { sid?: string };
      if (!json.sid) {
        throw new Error(`Twilio sendSms returned no sid: ${JSON.stringify(json)}`);
      }
      logger.debug({ to, sid: json.sid, status: res.status }, "twilio.sendSms ok");
      return { sid: json.sid, dryRun: false, status: res.status };
    },
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function cryptoRandomId(): string {
  // Short identifier for dry-run sids; collisions are fine — sids are
  // only used for log-correlation in this mode.
  return Math.random().toString(36).slice(2, 12);
}
