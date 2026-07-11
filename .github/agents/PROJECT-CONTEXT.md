# PROJECT-CONTEXT: Callwright

## One-liner
Callwright is a self-hosted, single-user Node.js MCP server that validates,
composes, and dispatches outbound calls through Retell, then retrieves and
learns from their outcomes.

## Architecture principles (immutable unless explicitly revised)
- Reusable behavior belongs in pure `*-core.js` modules; `server.js` and CLI
  files are thin adapters.
- One generic Retell agent receives scenario-neutral dynamic variables; do not
  create per-scenario agents or scenario-specific dialogue code.
- Spoken phrasing is language data in prompt/phrase assets. AI disclosure is
  mandatory and non-removable.
- `place_call` is dry-run by default. PII is minimized, values are shared only
  if asked, and read-backs expose keys/types rather than values.
- Automatic retry is bounded and disconnect-based: one retry by default.

## Module map / key files
- `server.js:38-901` — HTTP MCP server, tool registration, auth, Retell webhook,
  health route, and process entry point. This file is over 500 lines; main flow:
  helpers at 63-116, MCP tools at 118-742, HTTP/webhook routes at 746-876, start
  at 894-901.
- `dispatch-core.js:151-438` — validate/profile/compose/read-back/dispatch
  pipeline shared by MCP and CLI.
- `setup-core.js:1-434` — Retell provisioning, prompt/analysis migration,
  configuration, and setup status.
- `lang-core.js` — runtime language add/verify/update/remove.
- `learn-core.js` — profile enrichment and new-scenario candidate staging.
- `retry-core.js` — bounded disconnect classification and retry policy.
- `notify-core.js` — optional per-call SMS notification.
- `outcome-core.js` — canonical custom-status-first outcome interpretation.
- `generic-prompt.md`, `generic-prompt.ja.md`, `lang-phrases.json` — spoken
  behavior and language-owned wording.
- `paths.js` — mutable-state locations and `CALLWRIGHT_DATA_DIR`.

## Load-bearing / high-blast-radius paths
- `dispatch-core.js`, `server.js`, and `place_call.schema.json` gate paid calls
  and personal-data exposure.
- `generic-prompt*.md` controls disclosure, transfer behavior, payment limits,
  and recipient-facing speech.
- `setup-core.js` and `update-prompt.js` mutate hosted Retell agents; always pin
  agent and LLM versions.
- `retry-core.js` and `server.js` webhook handling can create additional paid
  calls; preserve caps and idempotence.
- `paths.js` and volume-resident JSON files contain mutable user state and must
  survive deploys.

## Build / test tooling
- Install: `npm install`.
- Unit tests: `npm test` (`node --test`, tests in `test/*.test.js`).
- Single file: `node --test test/<name>.test.js`.
- E2E / visual tests: not configured; no UI exists. Live phone-call validation
  is required for prompt/voice behavior.
- Lint / typecheck / build: none configured; runtime syntax checks use
  `node --check <file>`.
- Coverage / mutation gates: not configured.
- Current suite status: 106/106 green on 2026-07-11 using `npm test`.

## Deploy
- Environments:
  - Local/dev: `node server.js` on `http://127.0.0.1:8787`; controlled calls
    route through `test_to` and must disable retry.
  - Hosted production: Fly app `virtuphil`, expected URL
    `https://virtuphil.fly.dev`.
  - Retell prompt canary: exact unpublished agent version, routed only to the
    configured personal test number.
- Dev deploy command: no dedicated remote dev environment. Run locally with
  `node server.js`; verify `GET http://127.0.0.1:8787/health`.
- Prod deploy command: `flyctl deploy` — unverified in this context; requires
  explicit current-conversation approval and deploy-runner ownership.
- Auto-deploy triggers: none found under `.github/workflows/`.
- Retell prompt canary playbook:
  1. Confirm clean pushed HEAD and passing tests.
  2. Resolve and record exact numeric agent and attached LLM versions.
  3. Back up the current versioned agent prompt and
     `post_call_analysis_data` to the session findings/files directory.
  4. Preflight:
     `node update-prompt.js <agent_id> generic-prompt.md --prompt-analysis-only --agent-version <version> --dry-run`
  5. Refuse changes beyond `general_prompt` and
     `post_call_analysis_data`.
  6. Apply the same command without `--dry-run`.
  7. Repeat the dry-run and require no remaining changes.
  8. Place one call with `agent_version:<version>`, `test_to` set to the saved
     personal number, and `overrides.retry.max_retries:0`.
  9. Fetch the outcome and inspect transcript ordering plus canonical/raw
     analysis.
- Known-broken deploy patterns to REFUSE:
  - Unversioned Retell agent or LLM GET/PATCH operations.
  - Calling a business as the first canary.
  - Retrying a failed/no-answer canary without new user authorization.
  - Deploying Fly without persistent `/data` volume or required secrets.
  - Publishing npm/MCP registry as part of a hosted/Fly or Retell prompt deploy.
- In-flight-work hazard: Fly may stop/restart machines; runtime state must stay
  under `/data`. Retell prompt changes affect new calls using that agent version.
- Post-deploy verification probes:

  | Route / surface | Method | Expected | Why |
  |---|---|---|---|
  | `/health` | GET | 200 JSON `{ok:true}` | Server process and routing |
  | `/mcp` without auth | POST | 401 remotely | Bearer protection |
  | Retell migration dry-run | CLI | no changes after apply | Exact-version convergence |
  | Canary transcript | Retell GET call | short ask, AI disclosure, pause | Progressive disclosure |
  | Canary analysis | Retell GET call | custom `completed`; canonical no conflict | Outcome semantics |

- Rollback procedure:
  - Retell: PATCH the same numeric LLM/agent versions with the backed-up prompt
    and analysis array, re-fetch those versions, and verify exact restoration.
  - Fly: redeploy the previous known-good git commit with deploy-runner approval;
    do not delete or recreate the persistent volume.

## Known gotchas / latent bugs
- Retell built-in `call_successful` and custom analysis can disagree; consumers
  must use `outcome-core.js`.
- Existing hosted agents do not automatically receive repository prompt or
  analysis changes.
- Agent and Retell LLM versions are independent; use the version attached in
  `response_engine`.
- English and Japanese are fully supported. Runtime-added languages require
  native prompt/phrase review before production use.
- The independent `webhook/` deployment is not the MCP server webhook.

## Do-not-rebuild
- Reuse `dispatch-core.composeCall` and `placeCall`; do not duplicate dispatch
  behavior in adapters.
- Reuse `setup-core.POST_CALL_ANALYSIS` and version-pinned migration helpers.
- Reuse `outcome-core.resolveOutcome` in new outcome consumers.
- Reuse `retry-core` policy variables and caps.
- Reuse `lang-core` and phrase assets for language support.

## Environment notes
- Runtime: Node.js >=18, CommonJS, Windows development paths use backslashes.
- Secrets and personal runtime files are environment/volume-resident and
  git-ignored; never print or commit them.
- `RETELL_API_KEY` is required for Retell operations. Remote MCP requires
  `MCP_AUTH_TOKEN`; unset auth permits loopback only.
- Production deploys and hosted Retell mutations are owned by `deploy-runner`.
