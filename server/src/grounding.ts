// Excerpted from the PanelPrep production codebase for hackathon judging.

import { Timestamp, getFirestore } from 'firebase-admin/firestore';

import { config } from './config.js';
import { genai } from './genai.js';

const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function cacheKey(company: string, role?: string, seniority?: string): string {
  return [company, role ?? 'any', seniority ?? 'any']
    .join('|')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, '-');
}

/**
 * A current, source-grounded brief of how {company} interviews a {seniority} {role},
 * used to make the panel mirror that employer's real style. Cached in Firestore
 * (collection `briefs`) per company|role|level so we ground once per combo.
 */
export async function getInterviewBrief(
  company: string,
  role?: string,
  seniority?: string,
): Promise<string> {
  const db = getFirestore();
  const ref = db.collection('briefs').doc(cacheKey(company, role, seniority));

  const snap = await ref.get();
  if (snap.exists) {
    const d = snap.data();
    const created = (d?.['createdAt'] as Timestamp | undefined)?.toMillis?.() ?? 0;
    if (Date.now() - created < TTL_MS && typeof d?.['text'] === 'string') {
      return d!['text'] as string;
    }
  }

  const who = [seniority, role].filter(Boolean).join(' ') || 'engineer';
  const prompt = `Research how ${company} interviews a ${who}. Write a brief for an
interviewer who must mimic ${company}'s REAL process and style: the interview loop/stages,
common question themes with 1–2 concrete example questions, what they evaluate, and the
signals/rubric they look for. Be factual and current; 150–250 words; plain text.`;

  const ai = await genai();
  const res = await ai.models.generateContent({
    model: config.parseModel, // gemini-2.5-flash supports Google Search grounding
    contents: prompt,
    config: { tools: [{ googleSearch: {} }], temperature: 0.3 },
  });

  const text = res.text?.trim();
  if (!text) return '';
  await ref
    .set({
      text,
      company,
      role: role ?? null,
      seniority: seniority ?? null,
      createdAt: Timestamp.now(),
    })
    .catch(() => undefined);
  return text;
}
