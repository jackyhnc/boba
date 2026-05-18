# User TODO

Things only **you** can do — the agent can write code, but it can't sign legal documents, pay for accounts, or hand over your own API keys. Everything below is required to launch.

See [DEPLOY.md](./DEPLOY.md) for the end-to-end deploy walkthrough; this file is the punch list of what to acquire / sign up for *before* you deploy.

---

## Hard blockers (must complete before launch)

### Business + compliance
- [ ] **Form an LLC.** Required for Twilio 10DLC. ~$100 via Stripe Atlas, or $50–300 via your state. Takes ~1 week.
- [ ] **Write Privacy Policy + Terms of Service.** Required by Twilio 10DLC and by Apple if you ever ship an app. Easiest path: [Termly](https://termly.io) or [iubenda](https://iubenda.com) — ~$10/mo, takes an hour. Host them at `boba.dating/privacy` and `boba.dating/terms` (or similar).

### Twilio
- [ ] **Sign up for [Twilio](https://www.twilio.com/try-twilio).**
- [ ] **Buy a US long code phone number** with SMS *and* MMS enabled. ~$1/mo.
- [ ] **Register for A2P 10DLC** (Twilio console → Messaging → Regulatory Compliance). 1–3 business day approval. Without this, US carriers filter your messages. This is the longest-pole item — start it day one.
- [ ] **In your A2P brand registration: list `support@boba.app` (or whatever support email you'll actually staff) and confirm the opt-out copy.** Boba's own STOP/HELP/START handler is wired up (see "What you do NOT need to do" below), but you must still file the SAMPLE messages with the campaign or carriers will reject traffic.
- [ ] **Decide whether to enable Twilio's "Advanced Opt-Out" on your Messaging Service.** It's redundant with Boba's built-in STOP/HELP handling — keeping Twilio's on is harmless (it's idempotent), but if you customise our reply copy in `src/safety/smsKeywords.ts`, turn Twilio's off so users see your copy and not theirs.
- [ ] Once approved, get from the Twilio console and put in your host's secrets:
  - `TWILIO_ACCOUNT_SID` (starts `AC…`)
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_PHONE_NUMBER` (E.164, e.g. `+15555550123`)
  - `TWILIO_MESSAGING_SERVICE_SID` (recommended for scale)

### Infra
- [ ] **Buy a domain.** `boba.dating` / `getboba.app` / whatever you want. ~$10–15/yr from [Namecheap](https://namecheap.com), [Cloudflare](https://cloudflare.com), [Porkbun](https://porkbun.com).
- [ ] **Pick a host: Render or Fly.io.** Both ship in this repo. Render is one click via `render.yaml`. Fly is CLI-first via `fly.toml`. Costs ~$5–15/mo.
- [ ] **Production Postgres.** Auto-provisioned by Render's blueprint (free tier OK for beta). Fly: `flyctl postgres create`. Avoid using your laptop for prod.
- [ ] **Generate an `ADMIN_TOKEN`** for the `/admin/*` endpoints. Run locally: `openssl rand -hex 32`. Treat it like a password.

### Twilio webhooks
- [ ] **Wire the webhook URLs in Twilio.** After your host is up:
  - "A message comes in" → POST `https://<your-host>/webhooks/twilio/inbound`
  - "Status callback URL" → POST `https://<your-host>/webhooks/twilio/status`
- [ ] Set `PUBLIC_WEBHOOK_BASE_URL` to **exactly** the origin you put in Twilio (https, no trailing slash). Signature verification depends on character-perfect match.

---

## Optional

### AI seeding (cold-start cover)
- [ ] [Anthropic Console](https://console.anthropic.com) account.
- [ ] Generate an API key → set `ANTHROPIC_API_KEY` secret.
- [ ] Flip `AI_SEEDING_ENABLED=true`.
- [ ] Decide on the ethics story before turning it on (PRD open question).

### Error monitoring
- [ ] [Sentry](https://sentry.io) project (free tier OK).
- [ ] Set `SENTRY_DSN` secret. Sample rate already defaults to 10% — adjust `SENTRY_TRACES_SAMPLE_RATE` if needed.

### Apple side (only if/when you ship a native app)
- [ ] Apple Developer Program ($99/yr). The MVP is SMS-only — this is not required to launch.

---

## What you do NOT need to do

The code already handles all of these — listed so you don't reinvent them:

- ✅ Invite-code system (closed-beta gate)
- ✅ Onboarding state machine (12 SMS steps, MMS photo upload)
- ✅ Compatibility scoring + daily-match selector
- ✅ Conversation relay + milestone reveals
- ✅ End-of-day Keep/Maybe/Discard resolution + continuation matches
- ✅ Rematch eligibility (with `hasDiscard` permanent block + 14-day cooldown)
- ✅ Anti-doxxing + harassment auto-flag
- ✅ User REPORT keyword + auto-ban at 3 reports
- ✅ Carrier-required STOP / HELP / START keyword compliance (10DLC)
- ✅ AI-backed user plumbing
- ✅ Daily-match scheduler (cron) + manual trigger
- ✅ Admin endpoints (list users, view conversation, ban, run scheduler, bulk invites)
- ✅ Dockerfile, Render + Fly configs, /readyz health probe
- ✅ GitHub Actions CI
- ✅ Sentry hooks (no-op until you set the DSN)
- ✅ Local seed script (`npm run seed`)

See [DEPLOY.md](./DEPLOY.md) for the deploy walkthrough.
