# Callwright

A voice agent that places phone calls — reservations, appointments, confirmations, general inquiries — **on your behalf**, shaped by an LLM's direction + grounding. It discloses it's an AI, negotiates within bounds you set, never fabricates, and reports the outcome.

Built on [Retell](https://retellai.com). Exposed as an **MCP server** so any MCP-capable assistant (Claude, ChatGPT, Cursor, Copilot) can place calls for you — combining callwright (the *actuator*) with your other MCPs (WorkIQ, Gmail, calendar — the *sensors*) for context.

## Just ask

You don't fill out forms — you ask your assistant in plain language, and it gathers the context (from your calendar, email, or the chat), shapes the call, reads it back to you, and dials on your OK:

> *"Find the repair appointment in my calendar and call the contractor to confirm it's still on for Thursday."*

> *"Call Sakura Sushi and book a table for 4 this Friday at 7 — anytime between 6:30 and 8 is fine."*

> *"Ring my dentist and move my cleaning to sometime next week; my member ID is in my profile."*

> *"電話して、東京の美容院に明日の午後カットの予約を取って."* — *(places the call in Japanese)*

> *"Call this hotel in Kyoto and ask their hire-car rate to the airport — just gathering info, don't book."*

The assistant pulls only the minimal details each call needs, confirms the plan with you first, then places it fire-and-forget and fetches the outcome when you ask.

## How it works

```
You (chat) --> Host LLM --gathers context from other MCPs--> shapes a place_call
                  |
                  v
            callwright MCP  --validate + profile + compose + guard--> Retell --> phone
                  |                                                     |
                  +-- get_call_outcome / learn_from_call <-- outcome --+
```

- **Generic agent, not per-scenario.** One agent prompt = fixed guardrails (disclose AI, never pay, never fabricate, PII-minimize) + injected per-call direction. Handles any scenario and language.
- **Multilingual, extensible at runtime.** Ships speaking English and Japanese; `add_language` stands up a brand-new call language (translated prompt + a native voice + its own agent) entirely from chat — no redeploy. All language phrasing is data (`lang-phrases.json`), not code.
- **Purpose-first disclosure.** Opens with the goal ("I'm an AI assistant. I'm calling to confirm..."), not a name. Your name surfaces only when a business needs it.
- **Data minimization, filled lazily.** PII lives in `principal.facts` (shared *only if asked*); each call carries only the minimal relevant subset, and the read-back lists exactly which data types go out. When a call uses a durable fact you haven't saved, it offers to remember it — so the profile fills from use, not an upfront interview.
- **Learns from every call.** When a call defers on a missing detail, the profile is enriched so next time it's collected up front — manually (`learn_from_call`) or **automatically** via a signature-verified Retell webhook. A genuinely new scenario is *staged* and *proposed* (never silently created), with guards against over-specific splintering.
- **Bounded retry.** An unanswered/busy call is re-dialed — **exactly once by default**, never more without an explicit request (anti-spam).

## Tools

**Setup & profiles**
| Tool | Purpose |
|---|---|
| `get_setup_status` | What's configured / missing |
| `configure` | Save your name, callback, standing facts (+ optional provisioning) |
| `list_scenarios` | Known scenario profiles (+ pending candidates) |

**Calling**
| Tool | Purpose |
|---|---|
| `place_call` | **Dry-run by default** (returns read-back); `confirm:true` to dial. Supports `lang` and `overrides.retry` |
| `get_call_outcome` | Outcome + analysis + transcript by `call_id` |
| `list_recent_calls` | Recent calls |
| `list_retries` | Recent automatic no-answer re-dials |

**Languages**
| Tool | Purpose |
|---|---|
| `list_voices` | Browse Retell voices (for adding a language) |
| `list_languages` | Languages this server can call in |
| `add_language` | Add a new call language at runtime (translate → agent) |
| `verify_language` | Quality-gate a new language (review card + optional live test call) |
| `update_language` / `remove_language` | Change / remove an added language |

**Learning**
| Tool | Purpose |
|---|---|
| `learn_from_call` | Enrich a profile, or stage a new-scenario candidate |
| `list_candidates` | Staged scenario candidates (pending new profiles) |
| `create_profile` | Create a new scenario profile (propose-and-confirm, guarded) |
| `add_scenario_alias` | Merge a call type into an existing profile |
| `reject_candidate` | Drop a noise/one-off candidate |

`place_call` is fire-and-forget and **gated**: the first call returns a read-back (including the PII footprint); you dial only after confirming with `confirm:true`.

---

## Retell setup (prerequisites)

Callwright dials through [Retell](https://retellai.com), so you need a Retell account with **outbound calling enabled** before anything works. In the [Retell dashboard](https://dashboard.retellai.com):

1. **Create an account** and **add a payment method** (Stripe). Calls and phone numbers are pay-as-you-go; there's no Callwright fee on top.
2. **Complete KYC verification.** This is **required** to unlock **outbound calling** and **phone-number purchases** — without it, calls are blocked. (It's a one-time identity/business check; approval is usually quick.)
3. **Buy a phone number.** This becomes your caller ID (the `from` number). A US local number is cheapest; Callwright auto-selects it during `configure run_provisioning`.
4. **Create an API key** (Settings → API Keys). This is your `RETELL_API_KEY` — it stays server-side and must never go in a browser or chat.

**Optional, recommended:**
- **Verified phone number / branded calling** (dashboard → Telephony) — registers your number so carriers are less likely to tag it *"Spam Likely"*, which meaningfully improves pickup rates on outbound calls.

**Not required (and currently dormant here):**
- **A2P 10DLC registration** — only needed to *send SMS*, via a multi-step business-profile → brand → campaign approval with a recurring cost. Callwright's SMS notifications are built but shelved, so you can skip this entirely for placing calls.

> Costs are per-minute and destination-driven (roughly ~$0.015/min US, higher internationally) plus the monthly number rental.

---

## Run locally

```bash
npm install
node init.js                       # one-time setup wizard (number, agent, your identity)
export RETELL_API_KEY=key_xxx       # [Environment]::SetEnvironmentVariable on Windows
node server.js                      # MCP server on :8787
```

Check setup anytime: `node init.js status`.
Place a call from the CLI (bypassing MCP): `node dispatch.js <job.json> --go`.

---

## Deploy hosted (single-user)

Goal: a remote MCP URL **only you** can use. Works in both web clients (claude.ai, chatgpt.com) and local clients.

### 1. Pick a host with a **persistent disk**
`config.json` and `scenario-profiles.json` are written at runtime (by `configure` and `learn_from_call`), so avoid ephemeral/serverless filesystems. Good fits: **Fly.io** (volume), **Railway** (volume), **Render** (disk). A small always-on instance is fine — call volume is tiny.

### 2. Set environment variables (host dashboard)
```
RETELL_API_KEY = key_xxx            # your Retell secret - stays server-side
MCP_AUTH_TOKEN = <long random>      # the bearer token only you hold
PORT           = 8787               # or whatever the host injects
CALLWRIGHT_DATA_DIR = /data         # persistent volume for runtime state
CALLWRIGHT_PUBLIC_URL = https://your-host.example.com   # optional: enables the auto-learn webhook (Retell posts call_analyzed back here)
```
See `.env.example`. **Never** put the Retell key in a browser or chat.

### 3. Deploy
Docker is provided:
```bash
docker build -t callwright .
docker run -p 8787:8787 --env-file .env callwright
```
Or point the host at this repo (it auto-detects the Dockerfile). Mount a volume at the app dir so `config.json` / `scenario-profiles.json` persist across restarts.

### 4. First-run setup over MCP (no webpage needed)
Do setup **in chat**:
1. Connect the server (below).
2. Ask the assistant to call `configure` with `run_provisioning: true` and your name + callback number. That verifies the key, selects your Retell number, creates the generic agent, and saves your profile.
3. `get_setup_status` should now report `ready: true`.

(Or run `node init.js` once on the host shell if you prefer.)

---

## Connect a client

Replace the URL with your deployed host and the token with your `MCP_AUTH_TOKEN`. The server accepts the token **two ways**: an `Authorization: Bearer` header (Desktop/Code/Cursor) **or** a `?key=` URL query param (web clients whose connector form has no header field).

### Claude.ai (web)

The web connector form only takes a URL, so put the token in the URL:

1. **Settings → Connectors → Add custom connector** (or **Browse connectors → Add custom**).
2. **Name:** `Callwright`
3. **URL:** paste your host + `/mcp` + your token as `?key=`:
   ```
   https://your-host.example.com/mcp?key=<MCP_AUTH_TOKEN>
   ```
4. Save, then enable it in a chat (the 🔌/tools menu). Ask *"what callwright tools do you have?"* to confirm it connected.

> Because the token is in the URL, treat that connector URL like a password — anyone with it can place calls billed to your Retell account. Rotate by changing `MCP_AUTH_TOKEN` and updating the connector.

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "callwright": {
      "url": "https://your-host.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http callwright https://your-host.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### ChatGPT (Developer mode / connectors)

Add a custom MCP connector with the same URL — header or `?key=` both work.

> Keep **"confirm before running tools"** on. `place_call` is already dry-run-by-default, but tool-confirmation is a good second gate for an actuator that spends money and reaches real people.

---

## Security notes

- **Single bearer token = your lock.** Anyone with the token can place calls billed to your Retell account. Treat it like a password; rotate by changing `MCP_AUTH_TOKEN`.
- **Least-privilege Retell key.** Use a scoped key if you don't need full admin.
- **PII.** Standing facts are stored in `config.json` on your host. Calls send only the minimal subset, shared only if the business asks; the read-back shows the footprint every time.
- If `MCP_AUTH_TOKEN` is unset, the server accepts **loopback only** (local dev).

## Key files

| File | Purpose |
|---|---|
| `server.js` | MCP server (Streamable HTTP, bearer auth) + the auto-learn / retry webhook |
| `dispatch-core.js` | Validate → profile → compose vars → dispatch (shared core) |
| `dispatch.js` | CLI over dispatch-core |
| `setup-core.js` | Provisioning + config + status + lazy-save helpers (shared by init & MCP) |
| `lang-core.js` | Runtime language management (add/verify/update/remove, voices) |
| `lang-phrases.json` | Per-language composed phrasing (data, not code) |
| `learn-core.js` | Profile enrichment + new-scenario candidate staging (anti-splintering) |
| `retry-core.js` | No-answer retry policy + bounded re-dial decisions |
| `init.js` | Terminal setup wizard (`node init.js` / `node init.js status`) |
| `update-prompt.js` | Push a prompt + tools + etiquette + webhook to an existing agent |
| `place_call.schema.json` | The job contract the LLM fills |
| `generic-prompt.md` / `.ja.md` | Generic agent prompts (guardrails + `{{variables}}`) |
| `scenario-profiles.json` | Learning profiles (recommended details per scenario) |
| `learn.js` / `get-call.js` | CLIs: enrich a profile / fetch a call outcome |
| `paths.js` | Resolves mutable state paths (honors `CALLWRIGHT_DATA_DIR`) |
| `docs/` | Design specs (add-language, profile-learning) |
| `webhook/` | Optional serverless Retell→Resend email notifier (independent of the MCP) |

> Per-user runtime files — `config.json`, `agents.json`, `.retell-ids.json`, `job.*.json`,
> `grounding.*.json` — are git-ignored. They're created at runtime (by `init`/`configure`) or
> are personal call data; never commit them. Start from `config.example.json` and `examples/`.

## A note on disclosure & legality

The agent **always discloses that it's an AI** at the start of every call — this is a hard,
non-removable behavior. AI-call disclosure is legally required in some jurisdictions (e.g.
California's B.O.T. Act) and is good practice everywhere. The agent also never fabricates
information and shares personal data only when a business asks for it. For commercial or
at-scale use, confirm requirements with counsel in your jurisdiction.

## Optional: proactive email on every call

See [`webhook/`](./webhook) — a serverless Retell→Resend notifier that emails you each outcome.
It is **independent of the MCP** (which retrieves outcomes on demand via `get_call_outcome`) and
is **not deployed or wired by default**.
