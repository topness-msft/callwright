# Spec: let `learn` create (not just enrich) scenario profiles

## Today

`learn_from_call` can **enrich an existing** profile (append a `recommended_detail` when the
agent had to defer on a recurring question) but **cannot create** a profile for an unmatched
`call_type`. A genuinely new recurring scenario (e.g. `hotel_transport_inquiry`) runs fine
**generically** but never gains a profile unless hand-authored.

This spec adds **profile creation** — while guarding against the real failure mode:

> **Profiles splintering into over-specific entries that bake in per-call parameters/values.**

---

## The one invariant that prevents splintering

**A profile stores SCHEMA, never VALUES.**

| | Lives in | Reusable? | Example |
|---|---|---|---|
| **Scenario** (`call_type`) | profile key + aliases | across all calls of this kind | `hotel_transport_inquiry` |
| **Field to collect** (`recommended_details`) | profile | across all calls of this kind | `destination` |
| **The actual value** (`scenario_details` / `principal.facts`) | the per-call job | NO — this call only | `destination = "Haneda"` |

The codebase **already** separates these: `recommended_details` are field *keys* ("what to
collect"); the values arrive per-call in `scenario_details`. Auto-creation must **preserve this
invariant** — every guard below is in service of it.

### The litmus test (apply to every creation/enrichment decision)

> **"Would this help a *different* call of the same kind?"**
>
> - Reused field → `recommended_details` (schema) ✅
> - One-call value → `scenario_details`/`facts` (parameter), **never** a profile field ❌
> - Reused scenario → a `call_type` profile ✅
> - One-off intent → just a generic call, **no profile** ❌

If a candidate field or `call_type` fails this test, it is a **parameter or an instance**, not
schema — reject it.

---

## Anti-splintering guards

### 1. `call_type` must be a GENERAL scenario, not an instance
Reject/normalize instance-shaped types that embed a value:
- ✅ `hotel_transport_inquiry`, `restaurant_reservation`
- ❌ `hotel_transport_to_haneda`, `friday_dinner_for_2`, `haircut_with_jenny`

**Heuristic:** if the proposed `call_type` contains a proper noun, a number, a date, or a
specific value (destination, name, party size), strip it to the general form and route the
specific part into per-call grounding instead.

### 2. Canonicalize before creating (prevent alias splintering)
`hire_car`, `airport_transfer`, `haiya`, `car_service` must **not** spawn four profiles. Before
creating, check whether the proposed type is semantically equivalent to an existing profile:
- First the existing fuzzy match (name/alias contains).
- Then an **LLM canonicalization** step: *"Is `<new_type>` the same scenario as any of
  `<existing profile names>`? If yes, return which one."* If yes → **add as an alias**, do not
  create.
- **Merge-over-create bias:** creation is the last resort, only for genuinely novel scenarios.

### 3. Fields must be GENERALIZED, never instance-valued
When extracting a `recommended_detail` from a deferral:
- ✅ "What's your destination?" → field `destination`
- ❌ "Is your destination Haneda?" → field `destination_haneda`

**Value-rejection guard:** reject any candidate field whose **key or description embeds a
specific value** (proper noun / number / date / quoted string). Such a "field" is a value in
disguise → it belongs in the job, not the profile.

### 4. Promotion threshold (N ≥ 2) — don't mint from one call
- A single occurrence of an unmatched `call_type` or an unanswered question → logged to a
  **`candidates` staging area**, NOT promoted.
- Only after the **same canonicalized scenario / field is seen ≥ N times** (default 2) does it
  get promoted to a real profile / `recommended_detail`.
- Rationale: a repeated gap is a real pattern; a one-off is noise. (Same guard discussed for
  auto-learn generally.)

### 5. Creation is a higher-stakes action than enrichment → gate it
| Action | Stakes | Default handling |
|---|---|---|
| Append a field to an **existing** profile | low | auto (with N≥2) |
| **Create a new** profile | high (grows the taxonomy) | **propose-and-confirm** — surface to the user/LLM with the proposed name + fields; create on approval |

Enrichment can be autonomous; **creation should be proposed**, not silent, so a human/LLM keeps
the taxonomy coherent.

### 6. Periodic consolidation pass (taxonomy ceiling)
A maintenance review (LLM or human) that:
- merges near-duplicate profiles (e.g. `car_service` + `hotel_transport_inquiry`),
- prunes `recommended_details` that turned out to be one-off values,
- folds rarely-used profiles back into a more general one.
Keeps the profile set **small and orthogonal** over time.

---

## Proposed mechanics

1. **Staging store** (`scenario-candidates.json`, on the same volume): records unmatched
   `call_type`s and unmapped deferred questions with occurrence counts + example call_ids.
2. **On each `learn_from_call`:**
   - Matched profile → enrich as today (existing path), with the value-rejection guard (#3).
   - Unmatched `call_type` → canonicalize (#2). If it maps to an existing profile, **propose an
     alias**. If genuinely novel, **increment its candidate count** (#4).
3. **Promotion:** when a candidate crosses N, emit a **proposal** (new profile name +
   generalized fields + suggested aliases) for confirmation (#5), then write it.
4. **`list_scenarios`** (MCP) gains a view of pending candidates/proposals so the user/LLM can
   approve, merge, or reject from chat.

## What stays unchanged
- The job schema (`scenario_details` for values, `principal.facts` for PII) — the value side.
- Generic-agent behavior — unmatched scenarios always still work without a profile.
- `recommended_details` remain field *keys* with human-readable descriptions (schema only).

## Status
**IMPLEMENTED & live (2026-06-28).** `learn-core.js` holds the deterministic anti-splintering
heuristics; `learn.js` is a thin CLI over it. The MCP `learn_from_call` tool is rewired in-process:
it ENRICHES a matched profile, or STAGES an unmatched (generalized) scenario as a candidate and emits
a PROPOSAL once seen >= N (default 2). New tools: `list_candidates`, `create_profile`
(propose-and-confirm; guards reject instance-shaped names #1, value-baked fields #3, and collisions
#2→merge), `add_scenario_alias` (merge-don't-splinter), `reject_candidate`. `list_scenarios` surfaces
pending candidates. Candidates persist in `scenario-candidates.json` on the volume.

The LLM owns the JUDGMENT the spec reserves for it (canonicalize merge-vs-create, propose-and-confirm
to the user); the code owns the deterministic heuristics + N≥2 staging. Creation is never silent.
Covered by 15 `node:test` cases; full lifecycle (stage→proposal→create_profile→place_call matches the
new profile→alias merge) verified locally; guards + tool wiring verified live on prod.

What's NOT built from this spec: the periodic consolidation pass (#6) — left as a future maintenance
tool (an LLM/human review that merges near-duplicate profiles + prunes one-off fields).

### Original design notes (for reference)
