# Migrate Gemini calls from AI Studio to Vertex AI

Date: 2026-10-22

Why: the shared AI Studio key (project gen-lang-client-0283960737, key fingerprint 9bb679006735) has returned HTTP 402 "prepayment credits are depleted" since 2026-10-05. This showcase holds no key. The production app it is curated from (indieNik/panel-prep) uses the Secret Manager secret `gemini-api-key` in project `panel-prep`, which is probably its own key, not the shared one; check which project owns it before assuming it is. Vertex AI bills the 01747A Free Trial credit (about Rs 24,000 left on 2026-10-09, ends 2026-12-26; after that, spend goes to the card).

## What uses the key in this repo
This repo is a curated, read-only excerpt for hackathon judging. It has no package.json, no deploy and no secrets. Code changes happen in indieNik/panel-prep first (see its `docs/VERTEX_MIGRATION.md`); this repo is then re-curated from it.
- SDK: `@google/genai` (version pinned in panel-prep, ^2.8.0).
- `server/src/token.ts:25` `new GoogleGenAI({ apiKey })` from `getGeminiApiKey()` (`./secret.js`, not included here); `ai.authTokens.create` at `:48` mints Live API ephemeral tokens with prompt, voice and the `hand_off` tool locked in.
- `server/src/grounding.ts:14` `new GoogleGenAI({ apiKey })`; `generateContent` at `:54` with Google Search grounding, `config.parseModel` (gemini-2.5-flash).
- `client/core/live/gemini-live.service.ts:178` browser connects to the Live API with the ephemeral token as `apiKey` (`live.connect` at `:179`), token fetched from the broker `/token` at `:156`.
- `server/src/panel.ts` and `client/core/live/panel.ts`: prompts and voices baked into the token; no SDK call.
- Docs that describe the token flow: `README.md`, `docs/ARCHITECTURE.md`.

## Target
Vertex AI (now branded Gemini Enterprise Agent Platform; the API host is still aiplatform.googleapis.com), project instagram-content-bot-479808, location us-central1. Owner login: thejaggerypoint@gmail.com.

## Steps
1. SDK. Already on `@google/genai`. No package change.
2. Client. Mirror panel-prep's single helper (`server/src/genai.ts`, `genai()`): `new GoogleGenAI({ vertexai: true, project, location })`, with the API-key path kept behind `GENAI_BACKEND=studio`. Route `token.ts` and `grounding.ts` through it. Env: GENAI_BACKEND=vertex, VERTEX_PROJECT=instagram-content-bot-479808, VERTEX_LOCATION=us-central1.
3. Credentials. Nothing runs from this repo. The production broker's Cloud Run service account (`panelprep-broker@panel-prep.iam.gserviceaccount.com`) needs roles/aiplatform.user on instagram-content-bot-479808; that grant is handled in panel-prep. The browser never gets a key or a Google token.
4. Models and known differences on Vertex (verified 2026-10-21/22):
   - gemini-2.5-flash works. gemini-3.5-flash is 404 in us-central1, so default to gemini-2.5-flash. The grounding model is already gemini-2.5-flash.
   - Google Search grounding works with the same tool config (`grounding.ts`).
   - Live API: gemini-3.8-live in us-central1. Vertex issues no client-side ephemeral tokens (`authTokens.create` is AI Studio only), so the browser needs a server-side WebSocket relay: the client connects to the broker, the broker opens the Vertex Live session with its service account and pipes messages both ways. Reference: ai-trading-bot `backend/voice_broker.py` `relay()`. Here that means `server/src/token.ts` becomes a session builder plus relay route, and `client/core/live/gemini-live.service.ts` opens a WebSocket to the broker instead of `new GoogleGenAI({ apiKey: token })`. The README's "locked ephemeral token" story becomes "prompts and voices stay on the server behind the relay".
5. Verify, deploy, clean up. After panel-prep ships on Vertex, re-curate `server/src/token.ts`, `server/src/grounding.ts` and `client/core/live/gemini-live.service.ts` from it, and update the token flow in `README.md` and `docs/ARCHITECTURE.md`. Keep admin, deploy and email material out of this repo. No secret to delete here; the production secret `gemini-api-key` is panel-prep's, and Nik decides on deleting it.

## Reference implementations
- indieNik/panel-prep `docs/VERTEX_MIGRATION.md`: the production plan this repo follows.
- order-taking-app `order-taking-backend/services/geminiService.js` and `docs/decisions/0009-gemini-on-vertex.md`: Node `@google/genai` with GENAI_BACKEND on Cloud Run.
- ai-trading-bot `backend/voice_broker.py`, `relay()`: the Live API WebSocket relay.
