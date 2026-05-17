# Deploying Boba

This guide walks the human (you) through everything required to put Boba in front of real users. It assumes the code is in place and CI is green — only the things you have to sign up for, name, or pay for are listed here.

> **TL;DR.** Two paths: **Render** (one-click blueprint, easiest) or **Fly.io** (CLI-first, cheaper at scale). Pick one. Twilio + Postgres + your domain are required either way. AI seeding and Sentry are optional.

---

## 0. Prerequisites (human-only)

You need to complete these before the app can go live. None of them are scriptable.

| # | Step | Where | Approx. time |
|---|------|-------|--------------|
| 1 | Form a business entity (LLC). Required for Twilio 10DLC. | Stripe Atlas / your state Secretary of State | 1 day + 1 week wait |
| 2 | Sign up for Twilio | https://www.twilio.com/try-twilio | 15 min |
| 3 | Buy a US long code phone number with SMS+MMS enabled | Twilio console → Phone Numbers → Buy a Number | 5 min |
| 4 | Register for **A2P 10DLC** (business + campaign) | Twilio console → Messaging → Regulatory Compliance | 1–3 business days |
| 5 | Buy a domain (e.g. `boba.dating`) | Namecheap, Cloudflare, Porkbun, etc. | 5 min |
| 6 | (optional) Sign up for Sentry | https://sentry.io | 5 min, free tier OK |
| 7 | (optional) Anthropic Console account for AI seeding | https://console.anthropic.com | 5 min |
| 8 | Decide where to host: **Render** or **Fly.io** | — | — |
| 9 | Write a privacy policy + ToS (required for 10DLC registration AND App Store) | https://termly.io or https://iubenda.com | 1 hour with a generator |

Until 10DLC is approved, US carriers will filter most outbound SMS. Plan around it — it's the longest wait.

---

## 1. Pick a hosting target

### Option A: Render (recommended for the first launch)

Render's blueprint (`render.yaml` in this repo) provisions the API service and a managed Postgres in one click.

1. Push this repo to GitHub.
2. Go to https://dashboard.render.com → **New +** → **Blueprint**.
3. Connect the GitHub repo. Render reads `render.yaml`.
4. When prompted, fill in the secrets marked `sync: false` (see §3 below). Everything else is preset.
5. Click **Apply**. Render builds the Dockerfile, runs `prisma migrate deploy`, and starts the service.
6. Note your public URL (e.g. `https://boba-api.onrender.com`).

Costs: ~$7/mo for the starter web service. Free Postgres works for the closed beta but auto-suspends after 90 days inactivity — upgrade to **starter** ($7/mo) before launch.

### Option B: Fly.io

```bash
# from this repo, after installing flyctl
flyctl auth login
flyctl launch --no-deploy --copy-config        # picks up fly.toml
flyctl postgres create --name boba-pg --region iad
flyctl postgres attach boba-pg                  # writes DATABASE_URL secret
# Set every secret (see §3 below):
flyctl secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... \
  TWILIO_PHONE_NUMBER=+1... PUBLIC_WEBHOOK_BASE_URL=https://boba.dating \
  ADMIN_TOKEN="$(openssl rand -hex 32)"
flyctl deploy
```

Costs: ~$5/mo for the smallest VM + ~$2 for the smallest Postgres. Cheaper than Render at scale but more CLI fiddling up front.

---

## 2. Point your domain at the deploy

- **Render**: dashboard → service → Settings → Custom Domains → add `api.boba.dating`. Render gives you a CNAME target.
- **Fly**: `flyctl certs add api.boba.dating` then add the AAAA/A records it prints.

Until DNS propagates, Twilio webhooks should be pointed at the platform's default URL (`*.onrender.com` / `*.fly.dev`). Both work for signature verification as long as `PUBLIC_WEBHOOK_BASE_URL` exactly matches.

---

## 3. Required secrets

These are all `sync: false` in `render.yaml` (you set them in the Render dashboard) or `flyctl secrets set …` for Fly.

| Secret | Where to get it |
|---|---|
| `DATABASE_URL` | Auto-injected by Render (blueprint link) or Fly (`flyctl postgres attach`). |
| `TWILIO_ACCOUNT_SID` | Twilio console → Account Info. Starts `AC…`. |
| `TWILIO_AUTH_TOKEN` | Twilio console → Account Info → Auth Token. |
| `TWILIO_PHONE_NUMBER` | The E.164 number you bought (e.g. `+15555550123`). |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional. Twilio console → Messaging → Services. Recommended for scale. |
| `PUBLIC_WEBHOOK_BASE_URL` | The public origin of your service. Must match Twilio's webhook URL **exactly** (https, no trailing slash). |
| `ADMIN_TOKEN` | Generate locally: `openssl rand -hex 32`. Required to call `/admin/*` endpoints. |
| `ANTHROPIC_API_KEY` | Optional. Only if `AI_SEEDING_ENABLED=true`. Anthropic console → API Keys. |
| `SENTRY_DSN` | Optional. Sentry → Projects → your project → Client Keys (DSN). |

Non-secret env vars (already preset by the blueprint/fly.toml) include `NODE_ENV`, `LOG_LEVEL`, `TWILIO_DRY_RUN=false`, `TWILIO_REQUIRE_SIGNATURE=true`, `INVITES_REQUIRED=true`, `SCHEDULER_ENABLED=true`, `SCHEDULER_CRON=0 21 * * *` (9pm UTC = 5pm ET). Override any in the dashboard if you want.

---

## 4. Wire Twilio to the deploy

1. In Twilio console → Phone Numbers → your number → **Messaging** tab.
2. **"A message comes in"**: Webhook, **HTTP POST**, `https://<your-host>/webhooks/twilio/inbound`.
3. **"Status callback URL"**: `https://<your-host>/webhooks/twilio/status`, **HTTP POST**.
4. Save.

The URL you put in Twilio MUST match `PUBLIC_WEBHOOK_BASE_URL` exactly — that's what the signature is computed over.

Once 10DLC is approved, flip `TWILIO_DRY_RUN=false` and `TWILIO_REQUIRE_SIGNATURE=true` (the blueprint already sets these).

---

## 5. Seed and smoke-test

```bash
# Generate a handful of invite codes via the admin API:
curl -X POST https://<your-host>/admin/invites/bulk \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"count": 20, "label": "launch"}'

# Send yourself a test text from your own phone to the Twilio number.
# Expect: "Welcome to Boba 🧋 … Reply with your invite code"
# Then reply with one of the codes from the bulk response.

# Trigger today's match cycle on demand (the scheduler also fires at SCHEDULER_CRON):
curl -X POST https://<your-host>/admin/run-daily-match \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

The admin endpoints (`/admin/users`, `/admin/match/:id`, `/admin/users/:id/ban`) are documented in `src/admin/routes.ts`.

---

## 6. Health monitoring

Both hosts ping `/health` for liveness and `/readyz` for readiness. Render shows a green dot when both succeed. Fly's deploy is gated on `/readyz` returning 200 before flipping traffic.

If `/readyz` returns 503 with `db_unreachable`, the API can't reach Postgres — check your `DATABASE_URL` secret.

---

## 7. CI

`.github/workflows/ci.yml` runs typecheck + lint + test + build + a Docker build on every PR and push to `main`. No secrets needed; the Docker step uses `push: false`. Add deploy-on-merge later when you're ready.

---

## 8. When something breaks

- **Twilio sent a 11200 / 11750 error**: the webhook URL doesn't match `PUBLIC_WEBHOOK_BASE_URL`, or HTTPS isn't terminating cleanly. Fix the env var or the DNS/cert before debugging anything else.
- **403 from `/webhooks/twilio/inbound`**: signature mismatch. Usually the same URL-mismatch cause as above.
- **Cron didn't fire**: confirm `SCHEDULER_ENABLED=true` and that you're looking at the right timezone (cron runs in UTC).
- **No matches got picked**: `/admin/users` to confirm `status=ACTIVE` users exist with `preferences` and `stats` rows; the selector silently skips ONBOARDING users.
- **Carrier filtering**: 10DLC not approved yet. Until then, only your own number reliably receives outbound SMS.

For deeper debugging, Sentry catches handler errors, and the structured pino logs (set `LOG_LEVEL=debug` temporarily) include the request id Fastify generates per request.
