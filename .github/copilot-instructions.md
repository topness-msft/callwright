# Callwright — Copilot instructions

Callwright is a **self-hosted, single-user MCP server** (Node.js, CommonJS) that places outbound phone calls on the user's behalf via [Retell](https://retellai.com). An LLM shapes each call's direction + grounding; Callwright validates, composes, and dispatches it fire-and-forget, then fetches the outcome on demand.

## Build / test / run

- Runtime: Node `>=18`, `"type": "commonjs"`. No build step.
- Install: `npm install`.
- Tests use the built-in Node test runner (no framework dependency):
  - Full suite: `npm test` (runs `node --test`, which discovers `test/*.test.js`).
  - Single file: `node --test test/retry-core.test.js`.
  - Single test by name: `node --test --test-name-pattern="classifyDisconnect" test/retry-core.test.js`.
- No linter or formatter is configured — don't add one unless asked.
- Run locally: `node init.js` (setup wizard) then `node server.js` (MCP server on `:8787`, `POST /mcp`). Installed globally the binaries are `callwright` and `callwright-init`.
- Place a call from the CLI (bypasses MCP): `node dispatch.js <job.json> --go`.

## Architecture — the core/wrapper split

The central convention: **all reusable logic lives in `*-core.js` modules that are pure of CLI concerns** (no `process.argv`, no stdin/stdout side effects). Thin wrappers adapt them to a surface:

- `dispatch-core.js` — the pipeline: **validate → profile-match → compose-vars → resolve-agent → dispatch**. Both the CLI and the MCP server call this in-process.
- `dispatch.js` — CLI over `dispatch-core`. `server.js` — the MCP server (Streamable HTTP + bearer auth) over the same cores.
- Other cores: `setup-core.js` (provisioning/config/status), `lang-core.js` (runtime language add/verify/update/remove), `learn-core.js` (profile enrichment + new-scenario candidate staging), `retry-core.js` (no-answer re-dial policy), `notify-core.js` (optional SMS).
- CLIs `learn.js` / `get-call.js` / `update-prompt.js` are similarly thin wrappers.

When adding behavior, put logic in the relevant `*-core.js` and keep `server.js` / the CLI as adapters — don't duplicate logic across the two surfaces.

## Key conventions & invariants

- **Phrasing is data, not code.** All spoken/composed wording is keyed by BCP-47 language in `lang-phrases.json`. `composeCall` has *no* language conditionals — it only injects values via `{key}` interpolation. Adding a language = adding a phrase block + agent, never editing code. Unknown languages fall back to English so a call never crashes for a missing phrase.
- **Learning stores SCHEMA, never VALUES.** Scenario profiles (`scenario-profiles.json`) record which *field keys* a scenario recommends (e.g. `service_type`), never a user's actual data. Every guard in `learn-core.js` protects this invariant (see `docs/profile-learning-spec.md`).
- **New scenarios are proposed, never silently created.** `learn_from_call` *stages* a candidate; `create_profile` confirms it, with anti-splintering guards against over-specific call types.
- **`place_call` is dry-run by default.** It returns a read-back (including the PII footprint) and only dials when `confirm:true` / `--go`. Preserve this gate.
- **Data minimization + stored-fact resolution.** `applyConfigBackfill` backfills only identity + callback from config. Stored `principal.facts` are resolved into a call's share-if-asked set by `composeCall`, but **only** the scenario-relevant subset: the matched profile's `recommended_details` keys (auto) plus any keys named in `principal.facts_from_store` (opt-in). The full store is never placed in the agent context, so a call recipient can only ever probe that call's subset. Values flow only into the `known_facts` prompt block and are never returned to the calling model; the read-back lists PII **keys/types only**, never values. An explicit `principal.facts` value always wins over the store.
- **Disclosure is non-removable.** The agent always discloses it's an AI at call start. Don't add a path that suppresses this.
- **Bounded retry.** Default is exactly one re-dial on no-answer/busy/failed; the retry chain self-terminates via an incrementing `retry_attempt` round-tripped through Retell dynamic variables (`retry-core.js`).

## State & paths

- Mutable runtime state resolves through `paths.js`, honoring `CALLWRIGHT_DATA_DIR` (for a persistent volume when hosted): `config.json`, `agents.json`, `scenario-profiles.json`, `scenario-candidates.json`, `retries.json`.
- `resolveAsset()` is **volume-first**: a runtime-added asset (e.g. a new language's prompt/phrases) on the volume overrides the image-baked seed.
- Per-user files (`config.json`, `agents.json`, `.retell-ids.json`, `job.*.json`, `grounding.*.json`) are **git-ignored** — created at runtime or personal call data. Never commit them; start from `config.example.json` and `examples/`.

## Integration points

- **Retell** REST API (`https://api.retellai.com`) via `fetch`; `RETELL_API_KEY` stays server-side only. `place_call.schema.json` is the AJV-validated job contract the host LLM fills.
- **Auth:** one `MCP_AUTH_TOKEN` bearer (header or `?key=` query param). Unset → loopback-only (local dev).
- **Auto-learn webhook:** if `CALLWRIGHT_PUBLIC_URL` is set, agents post `call_analyzed` back to `POST /webhook/retell` (signature-verified) to enrich profiles and drive retries.
- **TickTick task linkage:** when a call originates from a TickTick task, pass its opaque ID as `tracking.ticktick_task_id` on both the dry-run and confirmed `place_call` calls. Callwright stores it only in Retell metadata. If `CLAUDE_ROUTINE_URL` and `CLAUDE_ROUTINE_TOKEN` are configured, the final analyzed call wakes that Routine immediately. Never put task text or PII in tracking metadata.
- `webhook/` is an independent, not-wired-by-default serverless Retell→Resend email notifier — separate from the MCP server.

Design specs live in `docs/` (`add-language-spec.md`, `profile-learning-spec.md`) — consult them before changing language or learning behavior.
