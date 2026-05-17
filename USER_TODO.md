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
- `PUBLIC_WEBHOOK_BASE_URL`
- `ANTHROPIC_API_KEY` (optional, only for AI seeding)

## Deploy
- [ ] Pick a host (Fly.io, Render, Railway). The app is a single Fastify process + Postgres.
- [ ] Set up DNS for the chosen domain and point Twilio messaging webhook at `https://<host>/webhooks/twilio/inbound`.
