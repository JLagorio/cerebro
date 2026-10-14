import type { ReactNode } from 'react';
import { failNext, resetFaults } from '@/lib/mockFaults';
import { resetMockGit } from '@/lib/mockGit';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The state lab's presets (M64.1).
 *
 * A section that reads renders five states, and each is a sentence the
 * others must never be mistaken for (CV-05): it has data; it read and found
 * none; it read and found a value nobody recorded; some of it was recorded;
 * the read failed. A preset puts a real section into one of them over the
 * browser mock — by seeding the mock's seams and arming `failNext` — so the
 * lab shows it, and vitest and e2e replay the same preset and check it.
 *
 * Sections register by FILE: each module in `./sections/` exports `section`
 * or `sections`, and nothing here lists them, so parts that add sections side
 * by side never edit one registry.
 */

export const LAB_STATES = ['ready', 'empty', 'not-recorded', 'partial', 'unavailable'] as const;
export type LabState = (typeof LAB_STATES)[number];

/** What a preset's state looks like on screen, checked inside the stage. */
export interface LabExpect {
  /** CSS selectors that must each match. */
  present: string[];
  /** CSS selectors that must match nothing. */
  absent?: string[];
  /** Text the stage must contain. */
  text?: string;
}

export interface LabPreset {
  /** One line on what this preset stages, shown under the stage. */
  note: string;
  /** Seed every mock seam the section reads. Runs after the reset, so a
   * preset never depends on the one applied before it. */
  seed?: () => void;
  /** Commands armed to fail once, AFTER the vault opens, so a preset never
   * fails the scan. */
  failNext?: string[];
  expect: LabExpect;
}

export interface LabSection {
  /** Kebab-case, unique; the `?section=` value. */
  id: string;
  title: string;
  /** Where the section lives in the app. */
  surface: string;
  render(): ReactNode;
  states: Record<LabState, LabPreset>;
}

interface SectionModule {
  section?: LabSection;
  sections?: LabSection[];
}

/**
 * Flatten section modules, sort by id, and refuse a section that lacks a
 * state or shares an id. Exported so the refusal itself is testable.
 */
export function collectSections(modules: Record<string, SectionModule>): LabSection[] {
  const all = Object.entries(modules).flatMap(([path, mod]) => {
    const found = [...(mod.section === undefined ? [] : [mod.section]), ...(mod.sections ?? [])];
    if (found.length === 0) throw new Error(`state lab: ${path} exports no section`);
    return found;
  });
  const seen = new Set<string>();
  for (const section of all) {
    if (seen.has(section.id)) throw new Error(`state lab: two sections share the id ${section.id}`);
    seen.add(section.id);
    const missing = LAB_STATES.filter((state) => section.states[state] === undefined);
    if (missing.length > 0) {
      throw new Error(`state lab: section ${section.id} has no preset for ${missing.join(', ')}`);
    }
  }
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

let cached: LabSection[] | null = null;

/** Every section in `./sections/`, sorted by id, each with all five states. */
export function labSections(): LabSection[] {
  cached ??= collectSections(import.meta.glob<SectionModule>('./sections/*.tsx', { eager: true }));
  return cached;
}

/** The vault every preset opens: the mock's demo vault. */
export const LAB_VAULT = '/demo-vault';

/**
 * Put the mock into one preset: reset the disk, git and the faults, seed,
 * open the vault, and only then arm the faults.
 *
 * An aborted apply arms nothing: StrictMode starts the lab's apply twice, and
 * the superseded one must not leave a second armed failure behind it.
 */
export async function applyPreset(
  section: LabSection,
  state: LabState,
  signal?: AbortSignal,
): Promise<void> {
  const preset = section.states[state];
  resetMockFs();
  resetMockGit();
  resetFaults();
  preset.seed?.();
  await useVaultStore.getState().openVault(LAB_VAULT);
  if (signal?.aborted === true) return;
  for (const command of preset.failNext ?? []) failNext(command);
}

/** A preset as a link: `?section=<id>&state=<state>`. */
export function labUrl(section: string, state: LabState): string {
  return `?${new URLSearchParams({ section, state }).toString()}`;
}

export interface ParsedLabUrl {
  section: LabSection;
  state: LabState;
  /** Set when the link named something the lab does not have. */
  notice: string | null;
}

function isLabState(value: string | null): value is LabState {
  return value !== null && (LAB_STATES as readonly string[]).includes(value);
}

/**
 * Read a preset back from `location.search`. No query is the first section's
 * ready preset, silently; an unknown section or state falls back to that
 * same preset and says which name it did not know.
 */
export function parseLabUrl(search: string, sections: LabSection[] = labSections()): ParsedLabUrl {
  const params = new URLSearchParams(search);
  const wantSection = params.get('section');
  const wantState = params.get('state');
  const first = sections[0];
  if (first === undefined) throw new Error('state lab: no sections registered');
  if (wantSection === null && wantState === null) {
    return { section: first, state: 'ready', notice: null };
  }
  const section = sections.find((s) => s.id === wantSection);
  if (section === undefined) {
    return {
      section: first,
      state: 'ready',
      notice: `No section "${wantSection ?? ''}" — showing ${first.id}, ready.`,
    };
  }
  if (!isLabState(wantState)) {
    return {
      section: first,
      state: 'ready',
      notice: `No state "${wantState ?? ''}" — showing ${first.id}, ready.`,
    };
  }
  return { section, state: wantState, notice: null };
}

/** One preset as `window.__cerebroLabPresets` lists it for e2e. */
export interface LabPresetIndexRow {
  section: string;
  state: LabState;
  url: string;
  expect: LabExpect;
}

/** Every section × state, in sidebar order. */
export function presetIndex(sections: LabSection[] = labSections()): LabPresetIndexRow[] {
  return sections.flatMap((section) =>
    LAB_STATES.map((state) => ({
      section: section.id,
      state,
      url: `/state-lab.html${labUrl(section.id, state)}`,
      expect: section.states[state].expect,
    })),
  );
}

/** Every command some preset fails, for the fail box's suggestions. */
export function failableCommands(sections: LabSection[] = labSections()): string[] {
  const all = new Set<string>();
  for (const section of sections) {
    for (const state of LAB_STATES)
      for (const c of section.states[state].failNext ?? []) all.add(c);
  }
  return [...all].sort();
}

/** Check a preset's expectations against a mounted stage. Returns what failed;
 * empty means the stage shows the state the preset names. */
export function unmetExpectations(stage: ParentNode, expect: LabExpect): string[] {
  const problems: string[] = [];
  for (const selector of expect.present) {
    if (stage.querySelector(selector) === null) problems.push(`missing ${selector}`);
  }
  for (const selector of expect.absent ?? []) {
    if (stage.querySelector(selector) !== null) problems.push(`unexpected ${selector}`);
  }
  if (expect.text !== undefined && !(stage.textContent ?? '').includes(expect.text)) {
    problems.push(`no text "${expect.text}"`);
  }
  return problems;
}
