// Sentry initialization.
//
// Init is idempotent and a no-op when `SENTRY_DSN` is empty. Call once at
// process startup, BEFORE building the Fastify app, so error capture is
// installed before any route handler is registered.
//
// We deliberately keep the integration surface small: Sentry's HTTP/
// instrumentations install themselves on the Node default agent, and any
// `Sentry.captureException(...)` call after `initSentry()` reaches the
// service. The Fastify error hook below wires unhandled handler errors
// through to Sentry without changing reply semantics.

import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";

let initialized = false;

export interface SentryInitArgs {
  env: Pick<Env, "SENTRY_DSN" | "SENTRY_TRACES_SAMPLE_RATE" | "NODE_ENV">;
}

/**
 * Initialize Sentry if a DSN is configured. Returns true iff Sentry was
 * actually started (so callers can log it).
 */
export function initSentry({ env }: SentryInitArgs): boolean {
  if (initialized) return true;
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
  });
  initialized = true;
  return true;
}

/** Used by tests to re-arm a fresh init in a clean process state. */
export function _resetSentryForTests(): void {
  initialized = false;
}

/**
 * Attach Sentry to a Fastify instance. Handler errors are forwarded to
 * Sentry; the original reply path is preserved (Fastify still sends its
 * 500 response). When Sentry is not initialized, this is a no-op.
 */
export function attachFastifySentry(app: FastifyInstance): void {
  if (!initialized) return;
  app.addHook("onError", async (req, _reply, err) => {
    Sentry.withScope((scope) => {
      scope.setTag("path", req.routeOptions?.url ?? req.url);
      scope.setExtra("method", req.method);
      Sentry.captureException(err);
    });
  });
}

export { Sentry };
