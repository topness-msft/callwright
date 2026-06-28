# Provider abstraction (evaluated — Retell retained)

> **Decision (2026-06-23): stay on Retell.** This document is kept as (a) a record of the
> ElevenLabs evaluation and (b) a ready blueprint if we ever add a second provider. The live
> code is intentionally **not** refactored behind this interface — Retell is a direct,
> well-contained dependency.
>
> **Why Retell over ElevenLabs**, despite ElevenLabs' stronger voice/multilingual:
> 1. **Adoptability** — Retell is one self-contained platform ("paste API key, buy a number,
>    done"). ElevenLabs Agents needs a separate **BYO Twilio** account/number/billing, which is
>    real friction for an OSS tool meant for others to clone and run.
> 2. **Pay-as-you-go, no monthly floor** — Retell bills per-minute with no commitment, ideal for
>    a personal tool placing a handful of calls/month. ElevenLabs Agents pricing is
>    plan/subscription-oriented (a monthly floor).
> 3. **No capability gap** — Retell does everything we need (incl. IVR/`press_digit`); ElevenLabs'
>    edges (voice warmth, multilingual STT, `language_detection`) are quality improvements, not
>    blockers. They're documented below as a **fallback** if those ever become the dominant pain.

Callwright's "brain" (job schema, scenario profiles, grounding/direction composition,
disclosure & negotiation rules in the prompts, the 7 MCP tools, the learning loop) is
**platform-agnostic**. Only the *actuator* — the part that actually provisions agents and
dials phones — is platform-specific.

Today that actuator is **Retell**, reached via plain REST. This document defines the small
interface a provider must implement so the actuator becomes pluggable (Retell **or**
ElevenLabs, selected by a `CALLWRIGHT_PROVIDER` env var).

The actuator surface is tiny — **5 methods**. Everything else is reused unchanged.

## The interface

```js
// providers/<name>.js
module.exports = {
  // 1. Verify credentials; return the list of existing agents.
  async verifyKey(key) -> Agent[],

  // 2. List/resolve the outbound caller number.
  async resolveFromNumber(key, preferred) -> { from_number, numbers, needsChoice?, reason? },

  // 3. Reuse-or-create the generic agent from a prompt file + voice + language.
  //    Bakes in the call behavior (wait-for-greeting, IVR/DTMF tool, voicemail,
  //    hold tolerance, post-call analysis fields).
  async ensureGenericAgent(key, { agents, defaultId, promptFile, voiceId, lang }) -> { agent_id, created, reused },

  // 4. Place one outbound call, injecting per-call grounding as {{variables}}.
  async placeCall({ key, from, to, agentId, vars }) -> { call_id },

  // 5. Fetch a completed call's outcome + transcript.
  async getOutcome(key, callId) -> { status, disconnect, duration_s, analysis, transcript },
};
```

## Method mapping: Retell (today) vs ElevenLabs

| # | Method | **Retell** (current code) | **ElevenLabs** (verified equivalent) |
|---|---|---|---|
| 1 | `verifyKey` | `GET /list-agents` | `GET /v1/convai/agents` (list agents) |
| 2 | `resolveFromNumber` | `GET /v2/list-phone-numbers` (buy/list in-platform) | List imported numbers; **BYO Twilio/SIP** |
| 3 | `ensureGenericAgent` | `POST /create-retell-llm` + `POST /create-agent` (voice_id, language, stt_mode, interruption_sensitivity, `press_digit` + `end_call` tools, voicemail_option, post_call_analysis_data) | `POST /v1/convai/agents/create` with `conversation_config` (prompt, first_message, voice, system tools: `play_keypad_touch_tone`, `voicemail_detection`, `language_detection`, `end_call`, `skip_turn`) |
| 4 | `placeCall` | `POST /v2/create-phone-call` with `override_agent_id` + `retell_llm_dynamic_variables` | Outbound call API / batch-calls with per-call **dynamic variables** + overrides (`language`, `first_message`, `system_prompt`, `voice_id`) |
| 5 | `getOutcome` | `GET /v2/get-call/{id}` → `call_analysis.custom_analysis_data` | Conversation analysis API → analysis fields |

## What ports unchanged (the brain — ~70% of the code)

- `place_call.schema.json` — the job contract
- `scenario-profiles.json` + `learn.js` — profiles & learning loop
- `dispatch-core.composeCall()` — grounding → `{{variables}}` (BOTH platforms use identical
  `{{var}}` double-curly templating, so the composed output is portable verbatim)
- `generic-prompt.md` / `.ja.md` — the agent prompts (same `{{var}}` syntax)
- `server.js` — all 7 MCP tools, stateless HTTP, auth
- `setup-core` config/status/guard helpers

## What changes (the actuator — ~30%)

- Current Retell calls in `dispatch-core.dispatchCall`, `setup-core.{verifyKey,listNumbers,
  ensureGenericAgent}`, and `server.retell()`/`get-call.js` move behind `providers/<name>.js`.
- `dispatch-core`/`setup-core` call `provider.X()` chosen by `CALLWRIGHT_PROVIDER`
  (default `retell`).
- `providers/retell.js` is a straight extraction of today's code (no behavior change).
- `providers/elevenlabs.js` is the new implementation (~200–300 lines).

## Behavior parity notes (ElevenLabs has NATIVE solutions to our hand-tuned pain points)

| Callwright behavior (hand-tuned in Retell) | ElevenLabs native equivalent |
|---|---|
| `press_digit` for IVR menus | `play_keypad_touch_tone` (0-9,*,#, **pause control**, **out-of-band RFC 4733** — more robust) |
| Wait for callee greeting (`start_speaker:user` + 8s) | `skip_turn` system tool + turn-taking config |
| Voicemail handling (`voicemail_option`) | `voicemail_detection` system tool |
| Bilingual JA/EN STT garbling (our worst issue) | `language_detection` system tool (auto-switch mid-call) |
| `end_call` tool | `end_call` system tool |
| post_call_analysis_data | conversation analysis |

## Cost (rough, all-in per minute)

| | Retell | ElevenLabs |
|---|---|---|
| Voice stack | ~$0.07–0.08/min (bundled) | $0.08/min flat (paid tier) |
| LLM | passthrough | separate (credits) |
| Telephony US | $0.015/min (bundled) | BYO Twilio ~$0.014/min |
| Telephony Japan | $0.28/min (markup) | BYO Twilio ~$0.10–0.20/min raw |
| **US call all-in** | ~$0.10–0.15/min | ~$0.10–0.14/min (≈ parity) |
| **Japan call all-in** | ~$0.37–0.44/min | ~$0.20–0.30/min (cheaper) |

Tradeoff: ElevenLabs is ≈ parity (US) / cheaper (intl) per-minute, but adds **BYO Twilio
setup** + a small monthly plan floor. At personal volume, per-minute cost is pennies either
way — choose on capability (voice warmth, multilingual), not price.

## Status

This is a **design contract only** — the live code is NOT yet refactored behind it (the
production Retell path is untouched). Implementing it is a bounded follow-up:
1. Extract `providers/retell.js` from current code (no behavior change) + verify/deploy.
2. Add `CALLWRIGHT_PROVIDER` switch in `dispatch-core`/`setup-core`.
3. Implement `providers/elevenlabs.js` + a Twilio number.
4. A/B one real call per platform (esp. a bilingual Japanese call) before switching default.
