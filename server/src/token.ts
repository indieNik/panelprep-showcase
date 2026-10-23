// Excerpted from the PanelPrep production codebase for hackathon judging.

import { createHmac, randomUUID } from 'node:crypto';

import type { Tool } from '@google/genai';

import { config } from './config.js';

/**
 * Live voice runs through the shared vertex-gateway (Cloud Run, project
 * instagram-content-bot-479808; ADR 0002). Vertex AI issues no client-side
 * ephemeral tokens, so instead of an AI Studio token the broker signs a
 * short-lived, single-use gateway ticket that carries the FULL Live session
 * setup (system prompt, voice, transcription, tools). The gateway opens the
 * Vertex Live session with that setup and drops any setup frame the browser
 * sends, so the browser can neither read nor override the prompt, as before.
 */
export interface LiveTicket {
  /** wss://<gateway>/live?ticket=<JWT>; one connection, valid for ticketTtlSeconds. */
  url: string;
  model: string;
}

export interface SessionConfig {
  systemInstruction: string;
  voiceName: string;
  /** Optional function declarations (e.g. the panel hand_off tool). */
  tools?: Tool[];
  /** Hard end (epoch ms) of a guest demo: no ticket is issued after it. */
  expiresAt?: number;
}

/** App id registered in the gateway's `vertex-gateway-apps` secret. */
const GATEWAY_APP = 'panel-prep';

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** HS256 JWT, as the gateway verifies it (docs/CLIENTS.md in vertex-gateway). */
function signTicket(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * Build the Live `setup` in Vertex wire format (camelCase, short model id).
 * A guest demo gets no context-window compression, so a session that outlives
 * the demo's client-side time box still ends at the Live API's own audio
 * session limit instead of running on.
 */
export function buildLiveSetup(session: SessionConfig, demo = false): Record<string, unknown> {
  return {
    model: config.liveModel,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceName } } },
    },
    systemInstruction: { parts: [{ text: session.systemInstruction }] },
    ...(session.tools?.length ? { tools: session.tools } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    ...(demo ? {} : { contextWindowCompression: { slidingWindow: {} } }),
  };
}

/** Sign a single-use gateway ticket for one Live connection. */
export function mintLiveTicket(session: SessionConfig): LiveTicket {
  const { secret, url, ticketTtlSeconds } = config.gateway;
  if (!secret || !url) throw new Error('vertex-gateway is not configured');
  const nowS = Math.floor(Date.now() / 1000);
  if (session.expiresAt && session.expiresAt <= Date.now()) throw new Error('session_expired');
  // The gateway refuses exp more than 120 s ahead.
  const exp = nowS + Math.min(Math.max(10, ticketTtlSeconds), 110);
  const ticket = signTicket(
    {
      app: GATEWAY_APP,
      exp,
      jti: randomUUID(),
      setup: buildLiveSetup(session, session.expiresAt !== undefined),
    },
    secret,
  );
  const ws = url.replace(/^http/, 'ws').replace(/\/+$/, '');
  return { url: `${ws}/live?ticket=${encodeURIComponent(ticket)}`, model: config.liveModel };
}
