// Excerpted from the PanelPrep production codebase for hackathon judging.

import { InterviewType, Seniority } from '../models';

/* ---------------------------------------------------------------------------
   UI-only panel + setup data. The system prompt, personas, and voices live on
   the broker (server/src/panel.ts) and are baked into the locked ephemeral
   token — never shipped to the client.
--------------------------------------------------------------------------- */

export const ROLE_OPTIONS = [
  'Frontend',
  'Backend',
  'Full-Stack',
  'Mobile',
  'Data / ML',
  'DevOps / SRE',
  'QA / QE',
  'Product Manager',
  'Project Manager',
  'Engineering Manager',
] as const;

/** Spoken interview languages (English names — they go into the locked prompt). */
export const LANGUAGE_OPTIONS = [
  'English',
  'Hindi',
  'Kannada',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Italian',
  'Japanese',
  'Korean',
  'Mandarin Chinese',
] as const;

export const LEVEL_OPTIONS: Seniority[] = ['Junior', 'Mid', 'Senior', 'Staff'];

export const FOCUS_OPTIONS: InterviewType[] = [
  'Technical',
  'System Design',
  'Behavioral',
  'Mixed Panel',
];

export const COMPANY_OPTIONS = [
  'Google',
  'Meta',
  'Amazon',
  'Apple',
  'Microsoft',
  'Netflix',
  'OpenAI',
  'Startup',
] as const;

/** Lightweight panelist for display (avatars/labels) — no voice/persona. */
export interface UiPanelist {
  id: string;
  displayName: string;
  role: string;
}

export interface PanelPack {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  panel: UiPanelist[];
}

export const PANEL_PACKS: PanelPack[] = [
  {
    id: 'bar-raisers',
    name: 'The Bar-Raisers',
    blurb: 'Rigorous & probing — big-tech depth and trade-offs.',
    icon: '⚡',
    panel: [
      { id: 'lead', displayName: 'Maya', role: 'Bar-raiser · Staff Engineer' },
      { id: 'peer', displayName: 'Elena', role: 'Senior Engineer' },
    ],
  },
  {
    id: 'mentors',
    name: 'Friendly Mentors',
    blurb: 'Warm & supportive — build confidence, still substantive.',
    icon: '🌱',
    panel: [
      { id: 'lead', displayName: 'Sara', role: 'Engineering Mentor' },
      { id: 'peer', displayName: 'Hana', role: 'Senior Engineer' },
    ],
  },
  {
    id: 'loop',
    name: 'Big-Tech Loop',
    blurb: 'A Staff IC + a Hiring Manager — technical and behavioral.',
    icon: '🏢',
    panel: [
      { id: 'lead', displayName: 'Priya', role: 'Staff Engineer (technical)' },
      { id: 'peer', displayName: 'Aisha', role: 'Hiring Manager (behavioral)' },
    ],
  },
];

export function packById(id: string | undefined): PanelPack {
  return PANEL_PACKS.find((p) => p.id === id) ?? PANEL_PACKS[0];
}

/**
 * Culture-matched panelist names per interview language ([lead, peer]).
 * MIRROR of the broker's map (server/src/panel.ts) — the interview screen
 * matches these against server-sent speaker names for the active-speaker glow,
 * so keep the two identical. Unmapped (incl. custom) languages keep pack names.
 */
export const PANEL_NAMES_BY_LANGUAGE: Record<string, [string, string]> = {
  Hindi: ['Priya', 'Ananya'],
  Kannada: ['Deepa', 'Kavya'],
  Spanish: ['Lucía', 'Carmen'],
  French: ['Camille', 'Élodie'],
  German: ['Anna', 'Lena'],
  Portuguese: ['Ana', 'Beatriz'],
  Italian: ['Giulia', 'Chiara'],
  Japanese: ['Yuki', 'Aiko'],
  Korean: ['Ji-woo', 'Min-seo'],
  'Mandarin Chinese': ['Mei', 'Lin'],
};

/** Pack panel with display names localized to the interview language. */
export function localizePanel(panel: UiPanelist[], language?: string): UiPanelist[] {
  const names = language ? PANEL_NAMES_BY_LANGUAGE[language] : undefined;
  if (!names) return panel;
  return panel.map((p, i) => ({ ...p, displayName: names[i] ?? p.displayName }));
}

/** Role-congruent interviewer title for display (matches the server's roster). */
export function panelistTitle(role: string | undefined, index: number): string {
  const r = (role ?? '').toLowerCase();
  if (r.includes('product')) return index === 0 ? 'Group Product Manager' : 'Eng / Design partner';
  if (r.includes('project') || r.includes('program'))
    return index === 0 ? 'Delivery Director' : 'Senior Project Manager';
  if (r.includes('engineering manager'))
    return index === 0 ? 'Director of Engineering' : 'Senior Engineering Manager';
  if (r.includes('qa') || r.includes('qe') || r.includes('test'))
    return index === 0 ? 'QA Lead' : 'Senior SDET';
  return index === 0 ? 'Staff Engineer' : 'Senior Engineer';
}

/** Default panel for display when none is chosen. */
export const DEFAULT_PANEL: UiPanelist[] = PANEL_PACKS[0].panel;
