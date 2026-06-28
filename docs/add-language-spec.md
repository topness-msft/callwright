# Spec: `add_language` — let an LLM add a call language at runtime

## Goal

Let the host LLM stand up a **new call language entirely in chat** — no code change, no
redeploy. After it runs, `place_call` with `lang:"<new>"` conducts a fully native call.

## Why it's blocked today

Adding a language currently has 5 parts; **2 are hardcoded in source** (require a deploy):

| Part | State today |
|---|---|
| Translated prompt (`generic-prompt.<lang>.md`) | file baked into the image |
| Retell agent (language code + a voice that speaks it) | created via `ensureGenericAgent` / `setup-agent-from.js` |
| Register in `config.agents.by_lang[<lang>]` | runtime-writable (volume) |
| **MCP `lang` enum** = `["en","ja"]` | ❌ hardcoded — rejects a new code |
| **`composeCall` `isJa` branches** (voicemail, booking line, "none" text, principal_ref, must_confirm default, read-back preview) | ❌ hardcoded — a 3rd language falls through to English |

## The core principle (generalizes the `opening_ask` refactor)

> **Code injects VALUES (language-agnostic). Per-language PROMPT FILES own all PHRASING.**

Adding a language needs code changes today *only because language-specific phrasing leaked into
code* (the `isJa` branches). We already proved the fix once: `opening_ask` used to be
code-composed with a brittle regex; we made the **LLM author the spoken line** and the breakage
vanished. The remaining `isJa` strings are the same debt. Eliminate them and the code becomes
language-agnostic — then a new language is pure data (prompt + agent + registration).

---

## Prerequisite refactor (must land before the tool)

### 1. Open the `lang` enum ✅ DONE (2026-06-27, Fly v19)
`lang: z.enum(["en","ja"])` → a validated **free-form BCP-47 string** (validate *format*, not
membership). Unknown-but-registered languages route via `config.agents.by_lang`.

Implemented in `server.js`: `z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)`. The
`place_call` handler also computes `langSupported` (en OR a registered `by_lang` agent) and
(a) surfaces a `language_warning` on dry-run for an unregistered language, and (b) **refuses to
dial** (`confirm:true`) an unregistered language so a non-English call can't silently use the EN
agent. Verified live: en→EN agent, ja→JA agent, fr→EN agent + warning (dry) / blocked (confirm),
bad format rejected by schema. NOTE: this changed the tool schema → MCP clients must reconnect.

### 2. Eliminate every `isJa` branch in `dispatch-core` ✅ DONE (2026-06-27)
Phrasing moved out of code into a per-language **data file `lang-phrases.json`** (keyed by BCP-47
primary subtag; unknown languages fall back to `en`). `composeCall` now injects VALUES and
interpolates them into the language's phrase templates via a tiny `interp("{key}", vars)` helper —
**no language conditionals remain**.

> **Refinement vs the original plan:** these strings became a dedicated `lang-phrases.json` rather
> than living inside the agent prompt `.md` files. Reason: the voicemail (`voicemail_option`
> `static_text`) and the read-back preview are composed *outside* the agent prompt, so a data file
> keyed by language is the correct realization of "phrasing is per-language data, not code." The
> agent prompt `.md` still owns what the agent *speaks live*; `lang-phrases.json` owns code-composed
> helper strings. **The `{{variable}}` contract was left identical**, so en/ja behavior and the
> existing prompts were untouched — verified byte-identical across a 256-case old-vs-new matrix.

| Code-composed string | New home (`lang-phrases.json` key) |
|---|---|
| `voicemail_message` | `voicemail_callback` / `voicemail_no_callback` (inject `{objective}`/`{callback}`/`{behalf}`) |
| `booking_name_line` | `booking_name_line_named` / `booking_name_line_anon` (inject `{name}`) |
| `principal_ref` (anon) | `principal_ref_anon` |
| `known_facts` empty | `known_facts_none` |
| `must_confirm` default | `confirm.{base,party_size,join}` (party size added only if the language opts in) |
| `noneText` | `none_text` |
| `opening_ask` fallback | `opening_ask_fallback` |
| `openingPreview` (read-back) | `opening_preview` |

After this, `composeCall` emits values; `lang-phrases.json` renders phrasing. A new language is
now: add a `lang-phrases.<lang>` block + a `generic-prompt.<lang>.md` + an agent/voice.

### 3. Make the base prompt language-parameterized ✅ DONE (2026-06-27)
The English base prompt (`generic-prompt.md`) now carries the same language-handling rule the JA
prompt already proved (Identity section): conduct the call in the prompt's language by default;
translate any injected value written in another language rather than reading it verbatim (proper
nouns excepted); **but mirror the callee** — switch to their language if they use it, never refuse
it. Pushed live to the EN agent via `update-prompt.js`.

> **Implementation choice:** the rule is **baked per-language** (each translated prompt states it
> in its own language), not injected via a `{{call_language}}` variable. This matches the proven
> JA precedent and keeps the `{{variable}}` contract stable. Because `add_language` translates
> `generic-prompt.md` into the new language, every new language inherits the rule automatically —
> `generic-prompt.md` is now the canonical translation template.

### 4. Prompts become volume-resident for runtime-added languages ✅ DONE (2026-06-27)
Both the prompt files **and `lang-phrases.json`** are now resolved **volume-first**:
- `paths.resolveAsset(file)` returns a volume copy if one exists (`DATA_DIR/<file>`), else the
  image-baked file. `setup-core.loadPromptText` uses it, so `generic-prompt.<lang>.md` for a
  runtime-added language is read from the volume.
- `dispatch-core.loadPhrases` loads the image seed (en/ja) and **merges any volume
  `lang-phrases.json` on top, per language block** — so a runtime-added `fr` block persists on the
  volume while en/ja keep flowing from the image. Not cached (the file is tiny and `add_language`
  may write it at runtime).

On prod the volume currently has none of these files, so everything falls back to the image exactly
as before (verified: en/ja byte-identical). The volume-first path only activates once `add_language`
writes `generic-prompt.<lang>.md` + an `fr`-style block to the volume. Guarded so local dev
(`DATA_DIR="."`) skips the volume lookup entirely.


---

## The `add_language` MCP tool (enabled by the refactor)

**Inputs**
- `lang` (BCP-47, e.g. `fr`, `es`, `de`, `zh-CN`) — required
- `display_name` (e.g. "French") — required
- `prompt_text` — the full translated agent prompt. The host LLM produces this by translating
  the base prompt (translation is the LLM's strength). Optional: if omitted, the tool returns the
  base prompt for the LLM to translate and resubmit.
- `voice_id` — a Retell voice that speaks the language. **Optional, with a default** (see below);
  if provided it's validated against `list_voices(lang)`.
- `stt_language` — the agent STT locale (default = `lang`); single-language (we learned
  multilingual STT *hurts* — JA/EN garbling)

**Steps**
1. Validate `lang` format; refuse if already registered (offer `update_language`).
2. Persist `prompt_text` to the volume as `generic-prompt.<lang>.md`.
3. Create the Retell LLM + agent: language code, `voice_id`, `stt_mode:"accurate"`, the standard
   system tools (`press_digit`, `end_call`), voicemail option `{{voicemail_message}}`, post-call
   analysis fields, wait-for-greeting + hold settings — i.e. `ensureGenericAgent`'s baked
   behavior, parameterized by language/voice.
4. Register `config.agents.by_lang[lang] = agent_id`.
5. Return `{ agent_id, lang, voice_id }`.

**Companion tools**
- `list_voices(lang)` — filter Retell's catalog so the LLM can *pick* a valid voice (it can't
  invent one).
- `update_language` / `remove_language`.

---

## Companion: verify_language ✅ DONE (2026-06-28)
A dedicated quality-gate tool (closes the add_language loop). DRY-RUN returns a **review card**:
the exact phrase-composed spoken opening (greeting + ask + AI disclosure), the voicemail message,
name-handling line, and a native-review checklist — all routed through the language's own agent.
With `to:<phone>` + `confirm:true` it places a live self-call (defaulting `to` to the configured
`callback_number`) so the user judges accent/etiquette/disclosure by ear, then reads the transcript
via `get_call_outcome`. Pure helpers `buildVerificationJob` + `verificationCard` in `lang-core.js`,
covered by tests; live-verified on prod (dry-run review card for ja).

## Guardrails (this is where the care goes)

1. **Voice: default but overridable.** `voice_id` is optional. Resolution order:
   1. explicit `voice_id` arg →
   2. `config.defaults.voice_id` (the house voice) **if it appears in `list_voices(lang)`** →
   3. `RETELL_VOICE_ID` env / `11labs-Brian` **if it speaks `lang`** →
   4. else a sensible catalog pick for `lang`.

   This mirrors today's live behavior — `voice_id || RETELL_VOICE_ID || "11labs-Brian"` in
   `ensureGenericAgent`, where the multilingual `11labs-Brian` already drives **both** the EN and JA
   agents. Defaulting to the house voice gives **voice consistency across languages for free**;
   the user overrides anytime (pass `voice_id`, or later `update_language({lang, voice_id})`).
   **Whatever is resolved — default or explicit — must validate against `list_voices(lang)`;**
   reject a mismatch (the LLM can't invent a voice). The tool echoes the chosen voice + how to
   change it. The verification call (guardrail 2) is the backstop that catches a mediocre default
   by ear before production.
2. **Disclosure + etiquette must survive translation (legal + quality).** The AI-disclosure line
   is legally required in some jurisdictions; politeness conventions (e.g. Japanese keigo,
   greeting norms) matter. **Do not let an unreviewed machine-translated disclosure go live
   silently.** Require, before first production use:
   - a **verification test call** (`place_call` with `--to` your own number) in the new language,
     and/or
   - a read-back of the composed opening + disclosure for human/native approval.
3. **STT language.** Set the agent's STT to the single target locale + `accurate` (we learned
   bilingual STT degrades quality).
4. **Promotion to the repo.** A runtime-added language lives on the volume. To ship it in the OSS
   repo for other adopters, promote the volume prompt back into the image as
   `generic-prompt.<lang>.md` (same seed-vs-volume flow as profiles).

---

## What this does NOT change

- The job schema, scenario profiles, grounding/PII model — all language-agnostic already.
- Generic-agent behavior — unmatched/unknown still works; a language just adds native phrasing.
- The provider boundary — `add_language` is implemented per provider (Retell today); the
  ElevenLabs equivalent would use `language_detection` + its voice catalog.

## Effort

Bounded. The **refactor** (open enum + remove `isJa` + prompt-owns-phrasing) is the real work —
and it's debt we'd want gone regardless. The **tool** is then thin: translate (LLM) → persist
prompt → create agent → register. Voice selection and a verification call are the only
human/catalog touchpoints.

## Status

**IMPLEMENTED & live (2026-06-27).** All 4 prerequisite refactor steps done, then the tooling
shipped in `lang-core.js` + 5 MCP tools (`list_voices`, `list_languages`, `add_language`,
`update_language`, `remove_language`). Covered by 20 `node:test` cases (`npm test`) and a full prod
integration test (added a real French agent → native French dry-run with no warning → deleted the
Retell agent + unregistered, all over the hosted MCP).

Notes on what shipped vs this spec:
- Phrasing lives in `lang-phrases.json` (data file), not inside the prompt `.md` (step-2 refinement).
- `add_language` is a **two-phase handshake**: call with `lang`+`display_name` to get `base_prompt`
  + `base_phrases` to translate, then resubmit with `prompt_text`+`phrases`.
- `voice_id` is optional (defaults to the English house voice with a strong recommendation +
  accent-matched suggestions to override); it's validated for EXISTENCE only — Retell voices expose
  `accent`, not a language field, so the verification call is the real language-quality gate.
- Per-language metadata persisted in `config.languages[primary]` ({agent_id, llm_id, voice_id,
  language, display_name}); routing still uses `config.agents.by_lang[primary]`.
- Idempotent: reuses an existing `generic_<primary>` agent; cleans up an orphan LLM if agent
  creation fails; English is protected; writes are atomic + serialized; region variants collapse to
  one agent per primary subtag.
