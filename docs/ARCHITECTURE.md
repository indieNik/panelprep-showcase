# PanelPrep — architecture & key decisions

A companion to the [README](../README.md), adapted from the production status doc. Each decision below is recorded with its rationale.

## Stack

**Angular 21 (standalone, zoneless, signals) + Tailwind v4 + Firebase modular SDK via DI tokens.** No `@angular/fire` — its peer ranges lag Angular 21, so the Firebase Web SDK is injected directly through custom DI tokens. Zoneless change detection plus signals keeps the live-audio UI (active-speaker glow, transcript stream, status) reactive without zone patching overhead.

## Backend: a Cloud Run token broker (not Cloud Functions)

A small Node/TypeScript service on Cloud Run mints **ephemeral, single-use, short-lived** Gemini Live tokens and hosts the evaluator, resume/JD parser, company grounding, and Prep Track endpoints. Cloud Run gives a long-lived process (client caching of the Gemini SDK and secrets), no cold-start penalty on the WebSocket-adjacent path, and a single deployable unit.

## Security: the prompt is part of the credential

The defining security decision: the Gemini API key exists only in Secret Manager, and **the system prompt + voice + tools are built server-side and locked into the ephemeral token** via `liveConnectConstraints` (see [`server/src/token.ts`](../server/src/token.ts)). The browser connects with an empty config — it cannot read the prompt, swap the persona, or remove the interview-scope guardrails. This was verified by checking that prompt strings are absent from the shipped client bundle.

On top of that, every broker endpoint requires a **Firebase ID token** verified with `firebase-admin`, with a **per-uid rate limit**. Tokens are `uses: 1` with a short expiry and an even shorter new-session start window.

## Models

Different jobs, different models (all overridable via env):

| Job | Model class |
| --- | --- |
| Live panel / coach / prep sessions | Gemini Live native-audio (flash live) |
| Rubric evaluator | Gemini Pro (typed JSON output) |
| Resume/JD parse + grounding briefs | Gemini Flash |
| Lightweight routing | Gemini Flash Lite |

## Company grounding: retrieval without embeddings

On `/token`, a Google-Search-grounded "brief" of how the target company really interviews the chosen role/seniority is generated and **baked into the locked prompt** — the panel mirrors that employer's actual loop, stages, and question themes. Briefs are **cached in Firestore** (`briefs/`, keyed `company|role|level`, 14-day TTL), so each combination is grounded once. No vector store: the Google Search grounding tool *is* the retriever ([`server/src/grounding.ts`](../server/src/grounding.ts)).

## Multi-voice: one Live session per panelist, client-owned floor control

A Gemini Live session is locked to one voice, so a two-voice panel is **two concurrent Live sessions**, each with its own single-identity prompt and voice. An earlier spike (single session, one voice role-playing two names) was shelved; what made the shipped design work:

1. **The model signals the handoff itself** via a `hand_off` function tool declared in the locked token — no brittle client-side "guess when the turn is over" heuristics.
2. **The client is the single source of floor-control truth** ([`client/core/live/gemini-live.service.ts`](../client/core/live/gemini-live.service.ts)): only the active chair gets mic audio, and on handoff the transcript delta is synced into the other session as a `[HANDOFF]` text nudge.

Guards hardened from real interview transcripts:

- `hand_off` is **rejected** unless the candidate spoke since the last handoff (breaks panelist↔panelist ping-pong).
- A **verbal throw line without the tool call** still moves the floor (turn-end phrase detector; English-only — the tool call is the language-independent path).
- **1.5 s mic hold** after a switch (room noise can't barge-in the incoming reply) + a **5 s watchdog**: one reminder nudge, then the floor goes back — the room can never fall silent.
- **Interrupted turns flush immediately**, so barge-ins don't produce mislabeled mega-turns.

The architecture generalizes to N chairs — each chair is just another `(session, prompt, voice)` triple behind the same floor-control state machine.

## Resilience: sessions die, interviews don't

Gemini Live caps connection duration (~10 minutes) and emits `GoAway` before closing. The response:

- **Idle sessions** are marked dead and revived with a fresh single-use token at the next handoff (`/token` accepts a per-chair parameter).
- **The active session auto-resumes seamlessly**: re-mint → reconnect → `[HANDOFF]` continue-nudge, with the persisted transcript baked into the revived prompt by the broker. Capped resumes per call; on failure it degrades to a graceful "session ended — Continue" flow.
- The transcript is **persisted turn-by-turn** to Firestore, so no data is lost on any path, and `endedAt` stamps give a session-duration metric on the report.

## Interview language

The lobby offers preset languages plus free text; the choice flows into the locked prompts, so the panel conducts the entire interview in that language (the evaluator judges any language but reports in English). **Panelist names localize per language** (e.g. Hindi → Priya & Ananya) via a `PANEL_NAMES_BY_LANGUAGE` map that is deliberately **duplicated on server and client** — the client matches server-sent speaker names to drive the active-speaker glow, so the two maps must stay identical.

## Prep Track: the "step zero" closed loop

JD → generated skill-map roadmap (grounded via the same briefs cache) → resumable single-voice coached live sessions (a `prep` token mode; transcripts persisted) → automatic readiness scoring 0–100 (understanding/articulation with per-skill last scores; one-way "ready" at ≥ 70) → a handoff CTA that creates a **prefilled panel interview** back-linked to the prep — and the post-interview debrief coach's locked prompt gains the roadmap, so the debrief names which prepped skills the interview confirmed. Data lives at `users/{uid}/preps/{prepId}` with per-session `turns`, streamed to the UI as live `onSnapshot` signals ([`client/core/data/prep.service.ts`](../client/core/data/prep.service.ts)).

## Audio pipeline

A dedicated AudioWorklet captures the mic as 16 kHz mono PCM frames; playback schedules 24 kHz PCM chunks gaplessly and can be flushed instantly for barge-in ([`client/core/live/audio.ts`](../client/core/live/audio.ts)). The player is primed inside the user gesture so autoplay policies never block the panel's first words.
