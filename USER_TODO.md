# User TODO

Things only the human can do. Keep this list current — each overnight run should append/refresh.

## Required before production
- [ ] **Twilio account + phone number.** Sign up at https://www.twilio.com, buy a US long code or short code, enable SMS. We will need:
  - Account SID
  - Auth Token
  - Phone number (E.164 format, e.g. `+15555550123`)
  - Messaging Service SID (optional, recommended for scale)
- [ ] **Decide university for Phase 1.** Geographic / domain whitelist will key off this (e.g. `@stanford.edu`).
- [ ] **Domain name** for the webhook endpoint Twilio will POST to (e.g. `api.boba.app`). Needs HTTPS.
- [ ] **Production Postgres host** (Neon, Supabase, RDS, etc.). Local dev uses docker-compose.
- [ ] **Apple Developer account** — only required if/when we build a companion iOS app. The MVP is SMS-only so this can wait.
- [ ] **LLM provider key** (Anthropic or OpenAI) only when AI seeding is turned on. Disabled by default; not required for MVP.

## Env vars the user supplies
Once accounts exist, copy `.env.example` → `.env` and fill in:
- `DATABASE_URL`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `TWILIO_MESSAGING_SERVICE_SID` (optional)
- `PUBLIC_WEBHOOK_BASE_URL` — MUST exactly match what's set in the Twilio
  console webhook URL. The X-Twilio-Signature is computed over it; any
  mismatch (trailing slash, http vs https, wrong host) causes 403s.
- `TWILIO_DRY_RUN` — defaults to `true`. Set to `false` to actually send.
- `TWILIO_REQUIRE_SIGNATURE` — defaults to `false`. Set to `true` in
  production (enforces signature verification even if creds drift).
- `ANTHROPIC_API_KEY` (optional, only for AI seeding)

## Twilio console setup
Once you've bought a number and have credentials:
1. In the Twilio console, go to your phone number's "Messaging" section.
2. Under "A message comes in", select **Webhook**, method **HTTP POST**,
   and paste `https://<your-host>/webhooks/twilio/inbound`.
3. Under "Status callback URL" paste
   `https://<your-host>/webhooks/twilio/status` (POST).
4. Make sure `PUBLIC_WEBHOOK_BASE_URL` in your `.env` is the same origin
   (scheme + host) as the URLs above. The signature won't validate otherwise.
5. Flip `TWILIO_DRY_RUN=false` and `TWILIO_REQUIRE_SIGNATURE=true` for
   real traffic.

## Deploy
- [ ] Pick a host (Fly.io, Render, Railway). The app is a single Fastify process + Postgres.
- [ ] Set up DNS for the chosen domain and point Twilio messaging webhook at `https://<host>/webhooks/twilio/inbound`.
