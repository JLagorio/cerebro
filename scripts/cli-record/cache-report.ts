// Gate 1 of M56.12, the field: no model calls, read-only.
//
//   pnpm tsx scripts/cli-record/cache-report.ts <vault> [<vault>...]
//
// It reads every session file at <config home>/projects/*/*.jsonl (the config
// home is CLAUDE_CONFIG_DIR, else ~/.claude, as Claude Code itself picks it),
// keeps those whose lines say `entrypoint: sdk-cli` with a cwd equal to one of
// the given vaults' realpaths, and prints the field summary and Gate 1's
// verdict as JSON. It prints numbers only: no path, no text and no id, so
// what it shows from the owner's own sessions is aggregates (Q29).

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromVault, gate, sessionVersion, summarize, turnStats, type SessionStats } from './cache';

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Every top-level session file under `<projects>/*\/`: subagent transcripts live deeper and are not turns. */
export function sessionPaths(projects: string): string[] {
  if (!existsSync(projects)) return [];
  return readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry) =>
      readdirSync(join(projects, entry.name), { withFileTypes: true })
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map((file) => join(projects, entry.name, file.name)),
    );
}

export interface Report {
  vaults: number;
  /** Sessions read, by the CLI version their lines name. */
  versions: Record<string, number>;
  field: ReturnType<typeof summarize>;
  gate: ReturnType<typeof gate>;
}

/** The report over these session files' lines, for the vaults whose realpaths are `cwds`. */
export function report(files: readonly unknown[][], cwds: ReadonlySet<string>): Report {
  const stats: SessionStats[] = [];
  const versions: Record<string, number> = {};
  for (const lines of files) {
    if (!fromVault(lines, cwds)) continue;
    stats.push(turnStats(lines));
    const version = sessionVersion(lines) ?? 'unknown';
    versions[version] = (versions[version] ?? 0) + 1;
  }
  const field = summarize(stats);
  return { vaults: cwds.size, versions, field, gate: gate(field) };
}

function main(argv: string[]): void {
  if (argv.length === 0) {
    throw new Error('usage: cache-report.ts <vault> [<vault>...]');
  }
  const cwds = new Set<string>();
  for (const [index, vault] of argv.entries()) {
    const path = resolve(vault);
    if (!existsSync(path)) throw new Error(`Vault ${index + 1} of ${argv.length} does not exist.`);
    cwds.add(realpathSync(path));
  }
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const files = sessionPaths(join(home, 'projects')).map((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(parse),
  );
  console.log(JSON.stringify(report(files, cwds), null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
