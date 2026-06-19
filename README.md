# Callwright

A voice agent that places phone calls — reservations, appointments, confirmations, general inquiries — **on your behalf**, shaped by an LLM's direction + grounding. It discloses it's an AI, negotiates within bounds you set, never fabricates, and reports the outcome.

Built on [Retell](https://retellai.com). Exposed as an **MCP server** so any MCP-capable assistant (Claude, ChatGPT, Cursor, Copilot) can place calls for you — combining callwright (the *actuator*) with your other MCPs (WorkIQ, Gmail, calendar — the *sensors*) for context.

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
- **Purpose-first disclosure.** Opens with the goal ("I'm an AI assistant. I'm calling to confirm..."), not a name. Your name surfaces only when a business needs it.
- **Data minimization.** PII lives in `principal.facts` (shared *only if asked*); each call carries only the minimal relevant subset. The read-back lists exactly which data types go out.
- **Learns from failures.** When a call defers on a missing detail, `learn_from_call` enriches the scenario profile so next time it's collected up front.

## Tools

| Tool | Purpose |
|---|---|
| `get_setup_status` | What's configured / missing |
| `configure` | Save your name, callback, standing facts, report-to (+ optional provisioning) |
| `list_scenarios` | Known scenario profiles |
| `place_call` | **Dry-run by default** (returns read-back); `confirm:true` to dial |
| `get_call_outcome` | Outcome + analysis + transcript by `call_id` |
| `list_recent_calls` | Recent calls |
| `learn_from_call` | Enrich a profile from a completed call |

`place_call` is fire-and-forget and **gated**: the first call returns a read-back (including the PII footprint); you dial only after confirming with `confirm:true`.

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

All clients use the **remote URL + Authorization header**. Replace the URL with your deployed host and the token with your `MCP_AUTH_TOKEN`.

**Claude Desktop / claude.ai (Custom Connector), Cursor:**
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

**Claude Code:**
```bash
claude mcp add --transport http callwright https://your-host.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**ChatGPT (Developer mode / connectors):** add a custom MCP connector with the same URL and `Authorization` header.

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
| `server.js` | MCP server (Streamable HTTP, bearer auth) |
| `dispatch-core.js` | Validate → profile → compose vars → dispatch (shared core) |
| `dispatch.js` | CLI over dispatch-core |
| `setup-core.js` | Provisioning + config + status helpers (shared by init & MCP) |
| `init.js` | Terminal setup wizard (`node init.js` / `node init.js status`) |
| `setup-agent-from.js` | Create an extra agent from a prompt file (e.g. a language variant) |
| `update-prompt.js` | Push a prompt + tools + etiquette settings to an existing agent |
| `place_call.schema.json` | The job contract the LLM fills |
| `generic-prompt.md` / `.ja.md` | Generic agent prompts (guardrails + `{{variables}}`) |
| `scenario-profiles.json` | Learning profiles (recommended details per scenario) |
| `learn.js` | Enrich profiles from completed calls |
| `get-call.js` | CLI: fetch a call outcome |
| `paths.js` | Resolves mutable state paths (honors `CALLWRIGHT_DATA_DIR`) |
| `config.example.json` | Template for the per-user config (copy to `config.json`) |
| `examples/` | Sample job files for the CLI / as MCP-arg references |
| `webhook/` | Optional serverless Retell→Resend email notifier (not wired into the MCP) |

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
