// Excerpted from the PanelPrep production codebase for hackathon judging.

import { GoogleGenAI, Modality, Tool } from '@google/genai';

import { config } from './config.js';
import { getGeminiApiKey } from './secret.js';

export interface EphemeralToken {
  token: string;
  model: string;
}

export interface SessionConfig {
  systemInstruction: string;
  voiceName: string;
  /** Optional function declarations (e.g. the panel hand_off tool). */
  tools?: Tool[];
}

let aiClient: GoogleGenAI | null = null;

async function client(): Promise<GoogleGenAI> {
  if (aiClient) return aiClient;
  const apiKey = await getGeminiApiKey();
  aiClient = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  return aiClient;
}

const safeNumber = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Mint a short-lived, single-use ephemeral token with the FULL Live session
 * config baked in (system prompt, voice, transcription, resilience). Because the
 * config lives in the token's liveConnectConstraints, the browser can neither
 * read the prompt nor override it — it connects with an empty config.
 */
export async function mintEphemeralToken(session: SessionConfig): Promise<EphemeralToken> {
  const ai = await client();
  const now = Date.now();
  const expireTime = new Date(now + safeNumber(config.tokenTtlMinutes, 30) * 60_000).toISOString();
  const newSessionExpireTime = new Date(
    now + safeNumber(config.sessionStartWindowMinutes, 2) * 60_000,
  ).toISOString();

  const created = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: {
        model: config.liveModel,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: session.systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: session.voiceName } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: {},
          ...(session.tools ? { tools: session.tools } : {}),
        },
      },
      httpOptions: { apiVersion: 'v1alpha' },
    },
  });

  if (!created.name) {
    throw new Error('Failed to mint ephemeral token');
  }
  return { token: created.name, model: config.liveModel };
}
