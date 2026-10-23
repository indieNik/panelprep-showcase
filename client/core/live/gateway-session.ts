// Excerpted from the PanelPrep production codebase for hackathon judging.

import type { FunctionResponse, LiveServerMessage } from '@google/genai';

/**
 * A Live session over the shared vertex-gateway (plain WebSocket).
 *
 * The broker's /token route returns a wss:// URL with a single-use signed
 * ticket; the ticket carries the whole session setup (prompt, voice, tools),
 * so the client sends no setup frame. Frames are the standard Live JSON wire
 * format, all text. The @google/genai SDK cannot point live.connect() at a
 * custom URL, so this mirrors the small part of its Session API the services use.
 *
 * Vertex note: a turn with a tool call ends with `turnComplete` before any
 * speech; the spoken follow-up (if any) is a second turn after toolResponse.
 */
export interface GatewayCallbacks {
  onopen?: () => void;
  onmessage: (msg: LiveServerMessage) => void;
  onerror?: (e: { message: string }) => void;
  onclose?: (ev: { code?: number; reason?: string }) => void;
}

export class GatewaySession {
  private constructor(private readonly ws: WebSocket) {}

  /** Open the socket; resolves once it is open (like the SDK's live.connect). */
  static connect(url: string, cb: GatewayCallbacks): Promise<GatewaySession> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(url);
      const session = new GatewaySession(ws);
      ws.onopen = () => {
        opened = true;
        cb.onopen?.();
        resolve(session);
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        let msg: LiveServerMessage;
        try {
          msg = JSON.parse(ev.data) as LiveServerMessage;
        } catch {
          return;
        }
        cb.onmessage(msg);
      };
      ws.onerror = () => {
        if (!opened) reject(new Error('Could not reach the voice service.'));
        else cb.onerror?.({ message: 'Live session error' });
      };
      ws.onclose = (ev: CloseEvent) => {
        if (!opened) {
          reject(new Error(ev.code === 4401 ? 'Voice session ticket was refused.' : 'Could not reach the voice service.'));
          return;
        }
        cb.onclose?.({ code: ev.code, reason: ev.reason });
      };
    });
  }

  private send(frame: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Live session is not open');
    this.ws.send(JSON.stringify(frame));
  }

  /** A text turn (string = one user turn). */
  sendClientContent(p: { turns: string; turnComplete?: boolean }): void {
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: p.turns }] }],
        turnComplete: p.turnComplete ?? true,
      },
    });
  }

  /** Streamed mic audio (16 kHz PCM, base64). */
  sendRealtimeInput(p: { audio: { mimeType: string; data: string } }): void {
    this.send({ realtimeInput: { audio: p.audio } });
  }

  sendToolResponse(p: { functionResponses: FunctionResponse[] }): void {
    this.send({ toolResponse: { functionResponses: p.functionResponses } });
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      /* already closed */
    }
  }
}
