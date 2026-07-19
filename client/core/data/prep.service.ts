// Excerpted from the PanelPrep production codebase for hackathon judging.

import { Injectable, Signal, inject, signal } from '@angular/core';
import {
  CollectionReference,
  DocumentData,
  Firestore,
  Unsubscribe,
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { FIRESTORE } from '../firebase/firebase.providers';
import { Prep, PrepSession, PrepSkillStatus } from '../models';

/**
 * A live Firestore subscription: a signal that updates in place plus a `stop()`
 * to unsubscribe (call it from the component's ngOnDestroy).
 */
export interface PrepStream<T> {
  value: Signal<T>;
  stop: Unsubscribe;
}

/**
 * Firestore access for the Prep Track, scoped to the signed-in user. Sibling of
 * InterviewService.
 *
 * Layout:
 *   users/{uid}/preps/{prepId}
 *   users/{uid}/preps/{id}/sessions/{sessionId}          (P2+)
 *   users/{uid}/preps/{id}/sessions/{id}/turns/{turnId}  (P2+)
 */
@Injectable({ providedIn: 'root' })
export class PrepService {
  private readonly firestore: Firestore = inject(FIRESTORE);
  private readonly auth = inject(AuthService);

  private requireUid(): string {
    const uid = this.auth.user()?.uid;
    if (!uid) {
      throw new Error('Not signed in.');
    }
    return uid;
  }

  private prepsCol(uid: string): CollectionReference<DocumentData> {
    return collection(this.firestore, 'users', uid, 'preps');
  }

  /** Create a new prep at the start of setup. Returns its id. */
  async createPrep(partial: Partial<Omit<Prep, 'id' | 'uid'>> = {}): Promise<string> {
    const uid = this.requireUid();
    const ref = await addDoc(this.prepsCol(uid), {
      uid,
      status: 'active',
      skills: [],
      linkedInterviewIds: [],
      readiness: { score: 0, history: [] },
      ...partial,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  }

  /**
   * Live subscription to a single prep. `value()` is `undefined` while loading,
   * `null` when the prep doesn't exist, else the prep.
   */
  streamPrep(prepId: string): PrepStream<Prep | null | undefined> {
    const uid = this.requireUid();
    const value = signal<Prep | null | undefined>(undefined);
    const stop = onSnapshot(
      doc(this.firestore, 'users', uid, 'preps', prepId),
      (snap) => value.set(snap.exists() ? ({ id: snap.id, ...snap.data() } as Prep) : null),
      () => value.set(null),
    );
    return { value: value.asReadonly(), stop };
  }

  /** Live subscription to the user's preps, newest first. `undefined` while loading. */
  streamPreps(): PrepStream<Prep[] | undefined> {
    const uid = this.requireUid();
    const value = signal<Prep[] | undefined>(undefined);
    const q = query(this.prepsCol(uid), orderBy('createdAt', 'desc'));
    const stop = onSnapshot(
      q,
      (snap) => value.set(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Prep)),
      () => value.set([]),
    );
    return { value: value.asReadonly(), stop };
  }

  /** One-shot list of the user's preps, newest first (Activity page). */
  async listPreps(): Promise<Prep[]> {
    const uid = this.requireUid();
    const snap = await getDocs(query(this.prepsCol(uid), orderBy('createdAt', 'desc')));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Prep);
  }

  /** One-shot list of a prep's sessions, newest first (Activity page). */
  async listSessions(prepId: string): Promise<PrepSession[]> {
    const uid = this.requireUid();
    const snap = await getDocs(
      query(
        collection(this.firestore, 'users', uid, 'preps', prepId, 'sessions'),
        orderBy('startedAt', 'desc'),
      ),
    );
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PrepSession);
  }

  /** Set a single skill's mastery status (v1 lets users mark skills by hand). */
  async updateSkillStatus(prepId: string, skillId: string, status: PrepSkillStatus): Promise<void> {
    const uid = this.requireUid();
    const ref = doc(this.firestore, 'users', uid, 'preps', prepId);
    // Read the current skills off a one-shot get so we can patch just the one entry.
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('Prep not found.');
    const skills = ((snap.data() as Prep).skills ?? []).map((s) =>
      s.id === skillId ? { ...s, status } : s,
    );
    await updateDoc(ref, { skills, updatedAt: serverTimestamp() });
  }

  /**
   * Record a panel interview spawned from this prep (P3 handoff): append its id
   * to `linkedInterviewIds`. arrayUnion is idempotent, so a retried handoff never
   * duplicates the id.
   */
  async linkInterview(prepId: string, interviewId: string): Promise<void> {
    const uid = this.requireUid();
    await updateDoc(doc(this.firestore, 'users', uid, 'preps', prepId), {
      linkedInterviewIds: arrayUnion(interviewId),
      updatedAt: serverTimestamp(),
    });
  }

  private sessionsCol(uid: string, prepId: string): CollectionReference<DocumentData> {
    return collection(this.firestore, 'users', uid, 'preps', prepId, 'sessions');
  }

  /** Start a prep session doc. Returns its id (used for the live token + evaluate). */
  async createSession(prepId: string): Promise<string> {
    const uid = this.requireUid();
    const ref = await addDoc(this.sessionsCol(uid, prepId), {
      startedAt: serverTimestamp(),
    });
    return ref.id;
  }

  /**
   * Append one finalized transcript line to a session's `turns` subcollection.
   * Fire-and-forget from the caller (mirrors interview turn persistence): the
   * live stream stays authoritative, so a dropped write is non-fatal.
   */
  async addSessionTurn(
    prepId: string,
    sessionId: string,
    turn: { speaker: 'coach' | 'you'; role: 'user' | 'model'; text: string },
  ): Promise<void> {
    const uid = this.requireUid();
    await addDoc(
      collection(this.firestore, 'users', uid, 'preps', prepId, 'sessions', sessionId, 'turns'),
      { ...turn, ts: serverTimestamp() },
    );
  }

  /**
   * Delete a session doc — used to clean up orphans (a connect that failed
   * after the doc was created, or a session where nothing was said). Any turns
   * already written are unreachable noise; fine to leave for a batch cleanup.
   */
  async deleteSession(prepId: string, sessionId: string): Promise<void> {
    const uid = this.requireUid();
    await deleteDoc(doc(this.firestore, 'users', uid, 'preps', prepId, 'sessions', sessionId));
  }

  /** Mark a session finished (merge, so it never clobbers startedAt/other fields). */
  async endSession(prepId: string, sessionId: string): Promise<void> {
    const uid = this.requireUid();
    await setDoc(
      doc(this.firestore, 'users', uid, 'preps', prepId, 'sessions', sessionId),
      { endedAt: serverTimestamp() },
      { merge: true },
    );
  }

  /**
   * Score a finished session: POST to the broker, which reads the transcript +
   * skill map, writes the session summary/score, per-skill lastScores, and the
   * prep's readiness back to Firestore — so an active `streamPrep`/`streamSessions`
   * subscription updates on its own. Returns the fresh overall + readiness.
   */
  async evaluateSession(
    prepId: string,
    sessionId: string,
  ): Promise<{ overall: number; readiness: number }> {
    const idToken = await this.auth.getIdToken();
    const res = await fetch(`${environment.brokerUrl}/prep/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ prepId, sessionId }),
    });
    if (!res.ok) {
      let message = `Evaluator returned ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // non-JSON body — keep the status-based message
      }
      throw new Error(message);
    }
    const body = (await res.json()) as { overall: number; readiness: number };
    return { overall: body.overall, readiness: body.readiness };
  }

  /** Live subscription to a prep's sessions, newest first. `undefined` while loading. */
  streamSessions(prepId: string): PrepStream<PrepSession[] | undefined> {
    const uid = this.requireUid();
    const value = signal<PrepSession[] | undefined>(undefined);
    const q = query(this.sessionsCol(uid, prepId), orderBy('startedAt', 'desc'));
    const stop = onSnapshot(
      q,
      (snap) => value.set(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PrepSession)),
      () => value.set([]),
    );
    return { value: value.asReadonly(), stop };
  }

  /**
   * Generate the roadmap: POST to the broker, which reads the prep's JD/resume,
   * calls Gemini, and writes the skill map back into the prep doc — so an active
   * `streamPrep` subscription updates on its own. We only surface errors here.
   */
  async plan(prepId: string): Promise<void> {
    const idToken = await this.auth.getIdToken();
    const res = await fetch(`${environment.brokerUrl}/prep/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ prepId }),
    });
    if (!res.ok) {
      let message = `Planner returned ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // non-JSON body — keep the status-based message
      }
      throw new Error(message);
    }
  }
}
