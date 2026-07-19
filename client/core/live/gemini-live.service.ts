// Excerpted from the PanelPrep production codebase for hackathon judging.

import { Injectable, inject, signal } from '@angular/core';
import { FunctionCall, GoogleGenAI, LiveServerMessage, Session } from '@google/genai';

import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { InterviewService } from '../data/interview.service';
import { AudioPlayer, AudioRecorder } from './audio';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'ended' | 'error';
export type PanelistId = 'lead' | 'peer';

export interface TranscriptLine {
  speaker: 'candidate' | 'panelist';
  text: string;
  /** Panelist display name (e.g. "Maya") when speaker === 'panelist'. */
  name?: string;
}

interface TokenBundle {
  sessions: { id: PanelistId; name: string; token: string }[];
  model: string;
  kickoff: string;
}

/** Client-side state for one panelist's Live session (one chair = one voice). */
interface PanelistSession {
  id: PanelistId;
  name: string;
  session: Session | null;
  /** True while the underlying websocket is open and writable. */
  open: boolean;
  /** True once the session is gone for good (idle close, goAway) until revived. */
  dead: boolean;
  /** Transcript index up to which this session has conversation context. */
  syncedTo: number;
  /** Resolves when the backend confirms `setupComplete` for this session. */
  ready: Promise<void>;
  markReady: () => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Owns the live interview: ONE Gemini Live duplex session PER PANELIST, each
 * with its own server-locked prompt and voice. Only the "active" panelist
 * receives mic audio; the floor moves when the model calls the `hand_off`
 * tool — the client acks it, syncs the conversation delta into the other
 * session as text, and re-routes the mic. Sessions are revived with a fresh
 * single-use token if they drop while idle.
 */
@Injectable()
export class GeminiLiveService {
  private readonly interviews = inject(InterviewService);
  private readonly auth = inject(AuthService);

  readonly status = signal<LiveStatus>('idle');
  readonly error = signal<string | null>(null);
  readonly transcript = signal<TranscriptLine[]>([]);
  /** True while the panel is speaking (for avatar animation). */
  readonly speaking = signal(false);
  /** Name of the panelist currently speaking (the active session's owner). */
  readonly speakingName = signal<string | null>(null);
  /** Friendly note when a session ends for an expected reason (e.g. time limit). */
  readonly endedNote = signal<string | null>(null);
  /** True while the candidate's mic is muted (FAB toggle). */
  readonly muted = signal(false);

  private readonly sessions = new Map<PanelistId, PanelistSession>();
  private active: PanelistId = 'lead';
  private pendingHandoff: PanelistId | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private model = '';
  private recorderStarted = false;
  /** True once the candidate has spoken since the last handoff — a hand_off is
      rejected until then, which breaks panelist→panelist ping-pong loops. */
  private candidateSpoke = false;
  /** Drop mic frames until this time — protects a fresh nudge reply from being
      barge-in-interrupted by room noise the instant the floor switches. */
  private micHoldUntil = 0;
  /** Whether the new floor-holder has produced audio since the last handoff. */
  private audioSinceHandoff = true;
  private nudgeWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Auto-resumes used this call (Live connections die ~every 10 min). */
  private resumeCount = 0;
  /** Set during intentional shutdown so onClose doesn't try to auto-resume. */
  private shuttingDown = false;

  private readonly recorder = new AudioRecorder();
  private readonly player = new AudioPlayer();
  private interviewId = '';

  private pendingUser = '';
  private pendingModel = '';
  private kickoffText = '';

  async connect(interviewId: string): Promise<void> {
    if (this.status() === 'connecting' || this.status() === 'live') return;
    this.interviewId = interviewId;
    this.status.set('connecting');
    this.error.set(null);
    this.muted.set(false);
    this.active = 'lead';
    this.pendingHandoff = null;
    this.candidateSpoke = false;
    this.micHoldUntil = 0;
    this.audioSinceHandoff = true;
    this.resumeCount = 0;
    this.shuttingDown = false;

    try {
      // Prime playback inside the user gesture so audio isn't blocked.
      await this.player.prime();
      // The broker builds + locks each panelist's prompt/voice and returns the
      // kickoff; the client connects with empty configs (nothing sensitive here).
      const bundle = await this.fetchTokens(interviewId);
      this.model = bundle.model;
      this.kickoffText = bundle.kickoff;

      this.sessions.clear();
      for (const s of bundle.sessions) {
        this.sessions.set(s.id, this.blankState(s.id, s.name));
      }
      const lead = bundle.sessions.find((s) => s.id === 'lead');
      if (!lead) throw new Error('Token broker returned no lead session.');
      const peer = bundle.sessions.find((s) => s.id === 'peer');

      // The lead must connect (it opens the interview); a peer failure only
      // degrades — the peer is revived with a fresh token at the next handoff.
      await Promise.all([
        this.openSession('lead', lead.token),
        peer ? this.openSession('peer', peer.token).catch(() => this.markDead('peer')) : Promise.resolve(),
      ]);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : 'Failed to start the live session.');
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    for (const s of this.sessions.values()) s.open = false;
    await this.teardown();
    if (this.status() !== 'error') this.status.set('ended');
  }

  private blankState(id: PanelistId, name: string): PanelistSession {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    return { id, name, session: null, open: false, dead: false, syncedTo: 0, ready, markReady };
  }

  private async fetchTokens(interviewId: string, panelist?: PanelistId): Promise<TokenBundle> {
    const idToken = await this.auth.getIdToken();
    if (!idToken) throw new Error('Please sign in to start the interview.');
    const res = await fetch(`${environment.brokerUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(panelist ? { interviewId, panelist } : { interviewId }),
    });
    if (!res.ok) {
      throw new Error(`Token broker returned ${res.status}`);
    }
    const data = (await res.json()) as Partial<TokenBundle> & { token?: string };
    // Older broker: single-session response — run lead-only (no handoffs).
    const sessions =
      data.sessions?.length ? data.sessions : [{ id: 'lead' as const, name: 'Panel', token: data.token ?? '' }];
    return {
      sessions,
      model: data.model ?? environment.geminiLiveModel,
      kickoff: data.kickoff ?? '',
    };
  }

  private async openSession(id: PanelistId, token: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    state.session = await ai.live.connect({
      model: this.model,
      config: {},
      callbacks: {
        onopen: () => {
          state.open = true;
        },
        onmessage: (msg) => this.onMessage(id, msg),
        onerror: (e: ErrorEvent) => this.onSessionError(id, e.message || 'Live session error'),
        onclose: (ev?: { code?: number; reason?: string }) => this.onClose(id, ev),
      },
    });
  }

  private onMessage(id: PanelistId, msg: LiveServerMessage): void {
    const state = this.sessions.get(id);
    if (!state) return;

    // Server signals it's about to end the session (duration limit). An idle
    // session is marked dead (revived with a fresh token at the next handoff);
    // the ACTIVE session keeps going until it actually closes — onClose then
    // auto-resumes it seamlessly.
    if (msg.goAway && id !== this.active) {
      this.markDead(id);
    }

    if (msg.setupComplete) {
      state.markReady();
      // Start the mic once the LEAD confirms setup, and kick off the intake so
      // the panel speaks first. The kickoff is text, so it never hits the transcript.
      if (id === 'lead' && !this.recorderStarted) {
        this.startRecorder();
        try {
          state.session?.sendClientContent({ turns: this.kickoffText, turnComplete: true });
        } catch {
          /* non-fatal: the panel will still respond once the user speaks */
        }
      }
    }

    if (msg.toolCall?.functionCalls?.length) {
      this.onToolCall(id, msg.toolCall.functionCalls);
    }

    const content = msg.serverContent;
    // Only the active panelist has the floor; ignore stray content from the other.
    if (!content || id !== this.active) return;

    // Barge-in: model was interrupted — drop queued audio. Interrupted turns
    // never emit turnComplete, so flush now or this text would smear into the
    // next speaker's turn (mislabeled mega-turns in the transcript).
    if (content.interrupted) {
      this.player.clear();
      this.speaking.set(false);
      void this.flushTurn();
    }

    // Model audio out — the speaker is simply the active session's owner.
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) {
        this.player.enqueue(data);
        this.speaking.set(true);
        this.speakingName.set(state.name);
        // The floor-holder is audibly present — release the guards.
        this.audioSinceHandoff = true;
        this.micHoldUntil = 0;
      }
    }

    // Incremental transcriptions.
    if (content.inputTranscription?.text) {
      this.pendingUser += content.inputTranscription.text;
      this.candidateSpoke = true;
    }
    if (content.outputTranscription?.text) {
      this.pendingModel += content.outputTranscription.text;
    }

    if (content.turnComplete) {
      this.speaking.set(false);
      void this.completeActiveTurn();
    }
  }

  /** Ack tool calls; a `hand_off` from the active panelist moves the floor —
      but only if the candidate has spoken since the last handoff. Rejecting it
      (ok: false) breaks panelist→panelist ping-pong: the panelist just asked a
      question, so the right next sound is the candidate's answer. */
  private onToolCall(id: PanelistId, calls: FunctionCall[]): void {
    const state = this.sessions.get(id);
    const accept = id === this.active && this.candidateSpoke;
    try {
      state?.session?.sendToolResponse({
        functionResponses: calls.map((fc) =>
          fc.name === 'hand_off' && !accept
            ? {
                id: fc.id,
                name: fc.name,
                response: {
                  ok: false,
                  error:
                    'Rejected: the candidate has not answered your current question yet. ' +
                    'Keep the floor, stay quiet, and let the candidate answer.',
                },
              }
            : { id: fc.id, name: fc.name, response: { ok: true } },
        ),
      });
    } catch {
      /* socket closed underneath us; onClose handles it */
    }
    if (accept && calls.some((fc) => fc.name === 'hand_off')) {
      this.pendingHandoff = this.other(id);
      // Fallback: if the model never completes its turn after calling the tool
      // (the old dead-air failure mode), hand off anyway.
      this.handoffTimer ??= setTimeout(() => void this.performHandoff(), 2500);
    }
  }

  private other(id: PanelistId): PanelistId {
    return id === 'lead' ? 'peer' : 'lead';
  }

  private async completeActiveTurn(): Promise<void> {
    // Capture the spoken tail before flushing — used to detect a verbal throw
    // ("Elena, over to you.") where the model forgot the hand_off tool call.
    const spokenTail = this.pendingModel.trim().slice(-120).toLowerCase();
    await this.flushTurn();
    if (!this.pendingHandoff && this.candidateSpoke && this.isVerbalThrow(spokenTail)) {
      this.pendingHandoff = this.other(this.active);
    }
    if (this.pendingHandoff) await this.performHandoff();
  }

  /** Turn ended by addressing the co-panelist but without a hand_off call. */
  private isVerbalThrow(tail: string): boolean {
    const otherName = this.sessions.get(this.other(this.active))?.name?.toLowerCase();
    if (!otherName || !tail.includes(otherName)) return false;
    return /over to you|take it away|your turn|jump in|weigh in|any (thoughts|questions|thing)|anything (to add|you)|you (had|have|wanted|want|think)|what do you think|go ahead/.test(
      tail,
    );
  }

  /** Move the floor: revive the target if needed, sync context, re-route the mic. */
  private async performHandoff(): Promise<void> {
    const to = this.pendingHandoff;
    if (!to) return;
    const from = this.active;
    this.pendingHandoff = null;
    if (this.handoffTimer) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
    }
    if (this.nudgeWatchdog) {
      clearTimeout(this.nudgeWatchdog);
      this.nudgeWatchdog = null;
    }
    // Ensure the throw line is in the transcript so the delta includes it.
    await this.flushTurn();

    let target = this.sessions.get(to);
    if (!target || target.dead || !target.session) {
      target = await this.reviveSession(to).catch(() => undefined);
    }
    if (!target) {
      // Couldn't bring the co-panelist back — keep the floor with the current
      // panelist so the room never goes silent.
      this.nudge(this.active, '[HANDOFF] The floor stays with you — continue with your next question.');
      return;
    }

    await Promise.race([target.ready, delay(5000)]);
    this.active = to;
    this.candidateSpoke = false;
    this.audioSinceHandoff = false;
    // Hold the mic briefly so room noise can't barge-in the reply before it starts.
    this.micHoldUntil = Date.now() + 1500;

    const delta = this.deltaSince(target.syncedTo);
    target.syncedTo = this.transcript().length;
    this.nudge(
      to,
      `[HANDOFF] Conversation since you last spoke:\n${delta || '(nothing new)'}\nThe floor is now yours — continue naturally.`,
    );
    this.armNudgeWatchdog(to, from);
  }

  /** Transcript lines from `index` on, formatted for a [HANDOFF] context sync. */
  private deltaSince(index: number): string {
    return this.transcript()
      .slice(index)
      .map((l) => `${l.speaker === 'candidate' ? 'Candidate' : (l.name ?? 'Panel')}: ${l.text}`)
      .join('\n');
  }

  /** A nudged panelist that stays silent gets one reminder, then the floor goes
      back — the room must never be quiet enough to look like a dropped call. */
  private armNudgeWatchdog(to: PanelistId, from: PanelistId, attempt = 1): void {
    if (this.nudgeWatchdog) clearTimeout(this.nudgeWatchdog);
    this.nudgeWatchdog = setTimeout(() => {
      this.nudgeWatchdog = null;
      if (this.active !== to || this.audioSinceHandoff || this.status() !== 'live') return;
      if (attempt === 1) {
        this.nudge(to, '[HANDOFF] Reminder — the floor is yours. Respond to the candidate now.');
        this.armNudgeWatchdog(to, from, 2);
      } else {
        // Unresponsive co-panelist: hand the floor back.
        this.pendingHandoff = from;
        void this.performHandoff();
      }
    }, 5000);
  }

  /** Send a floor-control text message to one panelist's session. */
  private nudge(id: PanelistId, text: string): void {
    const state = this.sessions.get(id);
    try {
      state?.session?.sendClientContent({ turns: text, turnComplete: true });
    } catch {
      /* socket closed underneath us; onClose handles it */
    }
  }

  /** Re-mint a single-use token for one chair and reconnect it. */
  private async reviveSession(id: PanelistId): Promise<PanelistSession> {
    const prev = this.sessions.get(id);
    const bundle = await this.fetchTokens(this.interviewId, id);
    const info = bundle.sessions.find((s) => s.id === id);
    if (!info?.token) throw new Error(`No token for ${id}`);
    const state = this.blankState(id, info.name || prev?.name || 'Panel');
    // The revived session gets the persisted transcript baked into its prompt
    // by the broker; the delta since then travels in the [HANDOFF] nudge.
    state.syncedTo = prev?.syncedTo ?? 0;
    this.sessions.set(id, state);
    await this.openSession(id, info.token);
    return state;
  }

  /** Capture mic frames and stream them to the ACTIVE session as 16 kHz PCM. */
  private startRecorder(): void {
    if (this.recorderStarted) return;
    this.recorderStarted = true;

    this.recorder
      .start((base64Pcm) => {
        if (this.muted() || Date.now() < this.micHoldUntil) return;
        const state = this.sessions.get(this.active);
        if (!state?.open || !state.session) return;
        try {
          state.session.sendRealtimeInput({
            audio: { mimeType: 'audio/pcm;rate=16000', data: base64Pcm },
          });
        } catch {
          // Socket closed underneath us — stop sending; onClose handles it.
          state.open = false;
        }
      })
      .then(() => this.status.set('live'))
      .catch((e) => this.onError(e instanceof Error ? e.message : 'Microphone access failed.'));
  }

  /** Mute/unmute the candidate's mic without dropping the sessions. */
  toggleMute(): void {
    const next = !this.muted();
    this.muted.set(next);
    this.recorder.setMuted(next);
  }

  private async flushTurn(): Promise<void> {
    const activeState = this.sessions.get(this.active);
    const user = this.pendingUser.trim();
    let model = this.pendingModel.trim();
    this.pendingUser = '';
    this.pendingModel = '';

    // Defensive: strip a leading "Name:" prefix if the model still emits one.
    const names = [...this.sessions.values()].map((s) => s.name).filter(Boolean);
    if (names.length && model) {
      model = model.replace(new RegExp(`^(?:${names.join('|')})\\s*:\\s*`, 'i'), '');
    }

    const lines: TranscriptLine[] = [];
    if (user) lines.push({ speaker: 'candidate', text: user });
    if (model) lines.push({ speaker: 'panelist', text: model, name: activeState?.name });
    if (!lines.length) return;

    this.transcript.update((t) => [...t, ...lines]);
    // The active session heard/spoke everything up to here.
    if (activeState) activeState.syncedTo = this.transcript().length;

    // Persist (best-effort; the transcript UI is already updated). Panelist
    // turns keep the "Name: " prefix in storage so the evaluator and the
    // resume-transcript path stay unchanged.
    for (const line of lines) {
      this.interviews
        .addTurn(this.interviewId, {
          speaker: line.speaker,
          role: line.speaker === 'candidate' ? 'user' : 'model',
          text: line.speaker === 'panelist' && line.name ? `${line.name}: ${line.text}` : line.text,
        })
        .catch((e) => console.error('persist turn failed', e));
    }
  }

  /** An idle session dropped — remember to revive it at the next handoff. */
  private markDead(id: PanelistId): void {
    const state = this.sessions.get(id);
    if (!state) return;
    state.dead = true;
    state.open = false;
    try {
      state.session?.close();
    } catch {
      /* already closed */
    }
    state.session = null;
  }

  private onClose(id: PanelistId, ev?: { code?: number; reason?: string }): void {
    const state = this.sessions.get(id);
    if (state) state.open = false;
    // Losing an idle session is routine (server idle timeout) — no user impact.
    if (id !== this.active) {
      this.markDead(id);
      return;
    }
    // Surface the close reason for diagnosis (normal close is 1000).
    if (ev?.code && ev.code !== 1000) {
      console.warn(`[live] ${id} session closed code=${ev.code} reason=${ev.reason ?? ''}`);
    }
    // 1008 (policy) usually means a model / API-version mismatch — don't retry.
    if (ev?.code === 1008) {
      this.onError(
        `Live session closed: ${ev.reason ?? 'policy error (1008)'} — ` +
          'check the broker/client model and API version.',
      );
      return;
    }
    // Live connections die roughly every 10 minutes (goAway/duration limit).
    // Resume the ACTIVE chair seamlessly with a fresh token instead of ending
    // the interview and making the candidate click Continue.
    if (!this.shuttingDown && this.status() === 'live' && this.resumeCount < 8) {
      this.resumeCount++;
      void this.autoResume(id);
      return;
    }
    if (!this.shuttingDown && this.status() === 'live') {
      this.endedNote.set('Reached the session time limit — continue to pick up where you left off, or view your report.');
    }
    void this.teardown();
    if (this.status() === 'live') this.status.set('ended');
  }

  /** The active session dropped mid-interview: re-mint, reconnect, and nudge it
      to continue where it left off (the broker bakes the persisted transcript
      into the revived prompt). Falls back to the old "ended — continue" flow. */
  private async autoResume(id: PanelistId): Promise<void> {
    this.markDead(id);
    try {
      await this.flushTurn();
      const state = await this.reviveSession(id);
      await Promise.race([state.ready, delay(8000)]);
      const delta = this.deltaSince(state.syncedTo);
      state.syncedTo = this.transcript().length;
      this.audioSinceHandoff = false;
      this.micHoldUntil = Date.now() + 1500;
      this.nudge(
        id,
        `[HANDOFF] (Reconnected after a brief drop — do not mention it.) Conversation since you last spoke:\n${delta || '(nothing new)'}\nContinue the interview exactly where it left off.`,
      );
      this.armNudgeWatchdog(id, this.other(id));
    } catch {
      this.endedNote.set('Reached the session time limit — continue to pick up where you left off, or view your report.');
      await this.teardown();
      if (this.status() === 'live') this.status.set('ended');
    }
  }

  private onSessionError(id: PanelistId, message: string): void {
    if (id !== this.active) {
      this.markDead(id);
      return;
    }
    this.onError(message);
  }

  private onError(message: string): void {
    this.shuttingDown = true;
    for (const s of this.sessions.values()) s.open = false;
    this.error.set(message);
    this.status.set('error');
    void this.teardown();
  }

  /** Stop audio I/O and close all sessions. Safe to call multiple times. */
  private async teardown(): Promise<void> {
    this.recorderStarted = false;
    this.pendingHandoff = null;
    this.micHoldUntil = 0;
    if (this.handoffTimer) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
    }
    if (this.nudgeWatchdog) {
      clearTimeout(this.nudgeWatchdog);
      this.nudgeWatchdog = null;
    }
    // Persist any text accumulated since the last turnComplete so a session
    // cut mid-turn doesn't drop its final exchange.
    await this.flushTurn();
    await this.recorder.stop().catch(() => undefined);
    await this.player.stop().catch(() => undefined);
    this.speaking.set(false);
    this.speakingName.set(null);
    this.muted.set(false);
    for (const s of this.sessions.values()) {
      try {
        s.session?.close();
      } catch {
        /* already closed */
      }
      s.session = null;
    }
  }
}
