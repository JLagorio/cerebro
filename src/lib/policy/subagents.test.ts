/**
 * The subagent bounds, TS side (M91.1, M91.2a) — byte identity with Rust, the
 * same strict load refusals in the same words, the bounds the CLI runs under,
 * what a seated run adds, Cerebro's own agent types and the hardening
 * settings.
 *
 * @see src-tauri/src/policy/subagents.rs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mentionedTools } from '@/engine/toolGrant';
import RETIRED from '../../../shared/prompt/retired-terms.json';
import { sha256Hex } from '../sha256';
import {
  DESCRIPTION_CHARS,
  parseSubagents,
  SUBAGENTS,
  SUBAGENTS_DIGEST_PATH,
  SUBAGENTS_PATH,
  SUBAGENTS_RAW,
} from './subagents';
import { TOOL_APPROVAL, WEB_AXIS } from './toolApproval';
import { cliTool, TOOLS } from './tools';

const REPO = join(__dirname, '../../..');
const RAW = readFileSync(join(REPO, SUBAGENTS_PATH), 'utf8');

describe('subagents.v1.json is one artifact', () => {
  it('hashes to the digest the Rust loader also asserts', () => {
    // Regenerate deliberately after an edit with
    // `cargo test --lib policy::subagents::tests::write_subagents_digest -- --ignored`.
    const committed = readFileSync(join(REPO, SUBAGENTS_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(SUBAGENTS_RAW)).toBe(committed);
    expect(SUBAGENTS_RAW).toBe(RAW);
  });

  it('is the object vite imported', () => {
    expect(JSON.parse(RAW)).toEqual(SUBAGENTS);
  });

  it('holds the measured bounds, and no built-in agent type', () => {
    expect(Object.entries(SUBAGENTS.env)).toEqual([
      ['CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS', '1'],
      ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '1'],
      ['CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', '2'],
      ['CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION', '8'],
      ['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', '1'],
    ]);
  });

  it('adds the todo list alone on a seated run, never the shared task list (M91.2a)', () => {
    expect(Object.entries(SUBAGENTS.seated_env)).toEqual([
      ['CLAUDE_CODE_ENABLE_TASKS', '0'],
      ['CLAUDE_CODE_ENABLE_TODO_TOOLS', '1'],
    ]);
    for (const name of Object.keys(SUBAGENTS.seated_env)) {
      expect(SUBAGENTS.env).not.toHaveProperty(name);
    }
  });

  it('hardens every run against bypass and auto mode (M91.2a)', () => {
    expect(SUBAGENTS.settings).toEqual({
      permissions: { disableBypassPermissionsMode: 'disable' },
      disableAutoMode: 'disable',
    });
  });

  it('defines one researcher, which reads and changes nothing (M91.2a)', () => {
    expect(SUBAGENTS.presets.map((preset) => preset.name)).toEqual(['cerebro-researcher']);
    const [researcher] = SUBAGENTS.presets;
    expect(researcher.toolsets).toEqual(['read']);
    expect(researcher.web_when_held).toEqual(['WebSearch', 'WebFetch']);
    for (const name of researcher.web_when_held) {
      expect(cliTool(name)?.name).toBe(name);
      expect(cliTool(name)?.writes).toBe(false);
      expect(TOOL_APPROVAL.families.find((f) => f.id === cliTool(name)?.family)?.ceiling).toBe(
        WEB_AXIS,
      );
    }
    for (const row of TOOLS.tools.filter((one) => one.toolset === 'read')) {
      expect(row.kind, row.name).toBe('read_only');
      expect(row.confirmable, row.name).toBe(false);
    }
  });

  it('defines exactly the agent types the tool-approval table lets a run start', () => {
    const names = SUBAGENTS.presets.map((preset) => preset.name);
    expect(names).toEqual(TOOL_APPROVAL.agent_types.allowed);
    for (const name of names) expect(TOOL_APPROVAL.agent_types.builtin).not.toContain(name);
  });

  it('names no tool and no retired term in what the main model reads (CV-19, CV-20)', () => {
    const cli = TOOLS.cli_tools.flatMap((tool) => [tool.name, ...(tool.aliases ?? [])]);
    const inWord = (char: string) => /[\p{L}\p{N}_]/u.test(char);
    const namesWord = (text: string, word: string) => {
      for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
        if (!inWord(text.charAt(at - 1)) && !inWord(text.charAt(at + word.length))) return true;
      }
      return false;
    };
    expect(namesWord('then call `Read`.', 'Read')).toBe(true);
    expect(namesWord('Readers', 'Read')).toBe(false);
    for (const preset of SUBAGENTS.presets) {
      expect(mentionedTools(preset.description), preset.name).toEqual([]);
      for (const tool of cli) expect(namesWord(preset.description, tool), tool).toBe(false);
      for (const term of RETIRED.terms) {
        expect(preset.description.toLowerCase()).not.toContain(term.toLowerCase());
      }
    }
  });

  it('names the Claude Code the tool-approval table pins', () => {
    expect(SUBAGENTS.cli_version).toBe(TOOL_APPROVAL.cli_version);
  });
});

type Json = Record<string, unknown> & {
  env: Record<string, unknown>;
  seated_env: Record<string, unknown>;
  presets: Record<string, unknown>[];
  settings: Record<string, unknown> & { permissions: Record<string, unknown> };
};

function refused(mutate: (v: Json) => void): string {
  const copy = JSON.parse(RAW) as Json;
  mutate(copy);
  try {
    parseSubagents(copy);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the mutated artifact must not load');
}

const NOT_CLAUDE =
  'must name a Claude Code variable: CLAUDE_, then capitals, digits and underscores';
const NOT_PLAIN = 'must be 1 to 64 letters, digits, dots, dashes or underscores';
const NOT_A_SENTENCE =
  'must be one sentence on one line: a capital letter first, a full stop last, at most 300 characters';
const NOT_A_TYPE = 'must be one or more letters, digits, colons, dots, dashes or underscores';
const NOT_READING = 'must name toolsets of read_only rows on non-writing doors, not';
const PRESET = 'preset "cerebro-researcher"';

type Case = [string, (v: Json) => void, string];

const CASES: Case[] = [
  ['format', (v) => (v.format = 2), 'table: `format` must be 1'],
  ['cli_version', (v) => (v.cli_version = '2.1'), 'table: `cli_version` must be N.N.N'],
  ['PATH', (v) => (v.env.PATH = '/tmp'), `env PATH: \`env\` ${NOT_CLAUDE}`],
  ['CLAUDE_code', (v) => (v.env.CLAUDE_code = '1'), `env CLAUDE_code: \`env\` ${NOT_CLAUDE}`],
  ['CLAUDE_', (v) => (v.env.CLAUDE_ = '1'), `env CLAUDE_: \`env\` ${NOT_CLAUDE}`],
  [
    'a name out of order',
    (v) => (v.env.CLAUDE_A_FIRST = '1'),
    'env CLAUDE_A_FIRST: `env` must follow ASCII order',
  ],
  [
    'a value with a separator',
    (v) => (v.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1; rm'),
    `env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: \`env\` ${NOT_PLAIN}`,
  ],
  [
    'an empty value',
    (v) => (v.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = ''),
    `env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: \`env\` ${NOT_PLAIN}`,
  ],
  // M91.2a: a seated run's variables, by the same rules, and none that env
  // sets already.
  [
    'a seated variable not Claude Code’s',
    (v) => (v.seated_env.HOME = '/tmp'),
    `seated_env HOME: \`seated_env\` ${NOT_CLAUDE}`,
  ],
  [
    'a seated name out of order',
    (v) => (v.seated_env.CLAUDE_A_FIRST = '1'),
    'seated_env CLAUDE_A_FIRST: `seated_env` must follow ASCII order',
  ],
  [
    'a seated value with a space',
    (v) => (v.seated_env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1 2'),
    `seated_env CLAUDE_CODE_ENABLE_TODO_TOOLS: \`seated_env\` ${NOT_PLAIN}`,
  ],
  [
    'a seated variable env sets',
    (v) => (v.seated_env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '3'),
    'seated_env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: `seated_env` must not name a variable env already sets',
  ],
  // M91.2a: a preset's name, sentence, toolsets and web tools.
  [
    'a preset name with a space',
    (v) => (v.presets[0].name = 'cerebro researcher'),
    `preset "cerebro researcher": \`name\` ${NOT_A_TYPE}`,
  ],
  ['an empty preset name', (v) => (v.presets[0].name = ''), `preset "": \`name\` ${NOT_A_TYPE}`],
  [
    'a preset named twice',
    (v) => v.presets.push({ ...v.presets[0] }),
    `${PRESET}: \`name\` is named twice`,
  ],
  [
    'an empty description',
    (v) => (v.presets[0].description = ''),
    `${PRESET}: \`description\` ${NOT_A_SENTENCE}`,
  ],
  [
    'a description in lower case',
    (v) => (v.presets[0].description = 'reads the vault.'),
    `${PRESET}: \`description\` ${NOT_A_SENTENCE}`,
  ],
  [
    'a description without a full stop',
    (v) => (v.presets[0].description = 'Reads the vault'),
    `${PRESET}: \`description\` ${NOT_A_SENTENCE}`,
  ],
  [
    'a description on two lines',
    (v) => (v.presets[0].description = 'Reads.\nThen writes.'),
    `${PRESET}: \`description\` ${NOT_A_SENTENCE}`,
  ],
  [
    'a description too long',
    (v) => (v.presets[0].description = `R${'e'.repeat(299)}.`),
    `${PRESET}: \`description\` ${NOT_A_SENTENCE}`,
  ],
  [
    'no toolset',
    (v) => (v.presets[0].toolsets = []),
    `${PRESET}: \`toolsets\` must name at least one toolset`,
  ],
  [
    'an undeclared toolset',
    (v) => (v.presets[0].toolsets = ['search']),
    `${PRESET}: \`toolsets\` names no declared toolset: "search"`,
  ],
  [
    'a toolset twice',
    (v) => (v.presets[0].toolsets = ['read', 'read']),
    `${PRESET}: \`toolsets\` repeats toolset "read"`,
  ],
  [
    'a writing toolset',
    (v) => (v.presets[0].toolsets = ['read', 'write']),
    `${PRESET}: \`toolsets\` ${NOT_READING} "write"`,
  ],
  [
    'a toolset that proposes',
    (v) => (v.presets[0].toolsets = ['propose']),
    `${PRESET}: \`toolsets\` ${NOT_READING} "propose"`,
  ],
  [
    'the generated toolset',
    (v) => (v.presets[0].toolsets = ['proposals']),
    `${PRESET}: \`toolsets\` ${NOT_READING} "proposals"`,
  ],
  [
    'an unknown CLI tool',
    (v) => (v.presets[0].web_when_held = ['WebBrowse']),
    `${PRESET}: \`web_when_held\` names no CLI tool in the manifest: "WebBrowse"`,
  ],
  [
    'an alias instead of a row’s name',
    (v) => (v.presets[0].web_when_held = ['Task']),
    `${PRESET}: \`web_when_held\` names no CLI tool in the manifest: "Task"`,
  ],
  [
    'a web tool twice',
    (v) => (v.presets[0].web_when_held = ['WebFetch', 'WebFetch']),
    `${PRESET}: \`web_when_held\` repeats "WebFetch"`,
  ],
  [
    'a CLI tool that writes',
    (v) => (v.presets[0].web_when_held = ['WebFetch', 'Write']),
    `${PRESET}: \`web_when_held\` names a CLI tool the web switch does not hold: "Write"`,
  ],
  // A tool that records no write may still act: the shell, the subagent tool
  // and the cross-session messenger never ride along.
  ...(['Bash', 'Agent', 'SendMessage'] as const).map((name): Case => [
    `${name}, which records no write yet acts`,
    (v) => (v.presets[0].web_when_held = [name]),
    `${PRESET}: \`web_when_held\` names a CLI tool the web switch does not hold: "${name}"`,
  ]),
  // M91.2a: each hardening setting takes the one value Claude Code's schema
  // offers.
  [
    'auto mode allowed',
    (v) => (v.settings.disableAutoMode = 'enable'),
    'settings: `disableAutoMode` must be disable',
  ],
  [
    'bypass mode allowed',
    (v) => (v.settings.permissions.disableBypassPermissionsMode = 'allow'),
    'settings: `permissions.disableBypassPermissionsMode` must be disable',
  ],
];

describe('the same refusals in the same words', () => {
  it.each(CASES)('refuses %s', (_label, mutate, words) => {
    expect(refused(mutate)).toBe(`${SUBAGENTS_PATH}: ${words}`);
  });

  it('refuses the shapes serde refuses', () => {
    expect(refused((v) => (v.agents = []))).toContain('unknown field `agents`');
    for (const key of ['env', 'seated_env', 'presets', 'settings']) {
      expect(refused((v) => delete (v as Record<string, unknown>)[key])).toContain(
        `missing field \`${key}\``,
      );
    }
    expect(refused((v) => (v.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = 2))).toContain(
      'invalid type',
    );
    expect(refused((v) => (v.seated_env.CLAUDE_CODE_ENABLE_TASKS = false))).toContain(
      'invalid type',
    );
    expect(refused((v) => (v.presets[0].model = 'haiku'))).toContain('unknown field `model`');
    expect(refused((v) => delete v.presets[0].web_when_held)).toContain(
      'missing field `web_when_held`',
    );
    expect(refused((v) => (v.presets[0].toolsets = 'read'))).toContain('invalid type');
    expect(refused((v) => (v.settings.permissions.allow = ['Bash']))).toContain(
      'unknown field `allow`',
    );
    expect(refused((v) => (v.settings.env = {}))).toContain('unknown field `env`');
    expect(refused((v) => delete v.settings.disableAutoMode)).toContain(
      'missing field `disableAutoMode`',
    );
    expect(refused((v) => (v.settings.disableAutoMode = true))).toContain('invalid type');
  });

  it('loads an artifact that names no variable and no preset', () => {
    const none = JSON.parse(RAW) as Json;
    none.env = {};
    none.seated_env = {};
    none.presets = [];
    const table = parseSubagents(none);
    expect([table.env, table.seated_env, table.presets]).toEqual([{}, {}, []]);
  });

  it('loads a sentence of exactly the most characters, a multi-byte one included', () => {
    const longest = JSON.parse(RAW) as Json;
    longest.presets[0].description = `R${'é'.repeat(DESCRIPTION_CHARS - 2)}.`;
    expect(parseSubagents(longest).presets[0].description).toHaveLength(DESCRIPTION_CHARS);
  });
});
