// Replays shared/policy/mail.v1.json with src-tauri/src/policy/mail.rs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { splitFrontmatter } from './frontmatter';
import { isDateText } from './dateGrammar';
import { loadRegistry, parseRegistry, resolveGate } from '@/lib/trigger/registry';
import {
  MAIL,
  MAIL_PATH,
  MAIL_DIGEST_PATH,
  gateOpens,
  isKeptOutOfGit,
  isMailUrl,
  isMailPath,
  parseMailPolicy,
  type MailPolicy,
} from './mailPolicy';
const raw = readFileSync(MAIL_PATH, 'utf8');
it('hashes to the digest the Rust core also asserts', () => {
  expect(createHash('sha256').update(raw).digest('hex')).toBe(
    readFileSync(MAIL_DIGEST_PATH, 'utf8').trim(),
  );
  expect(parseMailPolicy(JSON.parse(raw))).toEqual(MAIL);
});
it('replays the shared mail cases', () => {
  for (const row of MAIL.host_cases) expect(isMailUrl(row.url), row.url).toBe(row.mail);
  expect(isMailPath('Sources/Mail/a.md')).toBe(true);
  expect(isMailPath('.comments/sources/mail/a.md.json')).toBe(false);
  for (const row of MAIL.path_cases) expect(isKeptOutOfGit(row.path), row.path).toBe(row.kept);
  for (const row of MAIL.gate_cases) {
    const table = parseMailPolicy({
      ...MAIL,
      gate: { ...MAIL.gate, open: row.open, scope: row.scope },
    });
    expect(gateOpens(row.kind, row.vault_id, row.store_uuid, table)).toBe(row.opens);
  }
  for (const row of MAIL.refusals) {
    const value = JSON.parse(raw) as Record<string, unknown>;
    let target = value;
    for (const key of row.at.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[row.at.at(-1)!] = row.set;
    expect(() => parseMailPolicy(value)).toThrow(new Error(row.error));
  }
});
it('refuses missing, unknown and mistyped fields', () => {
  const value = JSON.parse(raw) as { gate: Record<string, unknown> };
  delete value.gate.scope;
  expect(() => parseMailPolicy(value)).toThrow('mail: invalid shape');
  expect(() => parseMailPolicy({ ...MAIL, unknown: true })).toThrow('mail: invalid shape');
  expect(() => parseMailPolicy({ ...MAIL, kept_out_of_git: [42] })).toThrow('mail: invalid shape');
});
const pack = () =>
  parse(splitFrontmatter(readFileSync(MAIL.gate.pack, 'utf8')).yaml!) as Record<string, string>;
function accepted(
  table: MailPolicy,
  fields: Record<string, string>,
  registry = loadRegistry(),
): boolean {
  return (
    !table.gate.open ||
    (resolveGate(registry, 'R14', `connector:${table.gate.connector}`) !== null &&
      /^\d{4}-\d{2}-\d{2}$/.test(fields.decided_at) &&
      isDateText(fields.decided_at) &&
      fields.evaluation_result === 'fired' &&
      table.gate.scope === fields.scope)
  );
}
it('the Gmail pack names its gate and kinds, and an open gate requires owner acceptance', () => {
  const fields = pack();
  expect(fields.gate).toBe(`${MAIL.gate.registry}:connector:${MAIL.gate.connector}`);
  expect(fields.kinds.split(',').map((value) => value.trim())).toEqual(MAIL.gate.kinds);
  expect(accepted(MAIL, fields)).toBe(true);
  const open = { ...MAIL, gate: { ...MAIL.gate, open: true, scope: 'vault_store:one:two' } };
  expect(accepted(open, fields)).toBe(false);
  const raw = JSON.parse(readFileSync('shared/policy/trigger-registry.v1.json', 'utf8'));
  raw.entries[13].subcapability_pattern.registered_connectors = ['gmail'];
  const registry = parseRegistry(raw);
  const approved = {
    ...fields,
    scope: 'vault_store:one:two',
    decided_at: '2026-10-15',
    evaluation_result: 'fired',
  };
  expect(accepted(open, approved, registry)).toBe(true);
  expect(accepted(open, { ...approved, scope: 'vault_store:other:two' }, registry)).toBe(false);
  expect(accepted(open, { ...approved, evaluation_result: 'not_fired' }, registry)).toBe(false);
  expect(accepted(open, { ...approved, decided_at: 'pending' }, registry)).toBe(false);
});

it('numeric JSON spellings and Unicode whitespace agree with the Rust loader', () => {
  expect(parseMailPolicy(JSON.parse(raw.replace('"format": 1,', '"format": 1.0,'))).format).toBe(1);
  expect(parseMailPolicy({ ...MAIL, rule_version: '\uFEFF' }).rule_version).toBe('\uFEFF');
});
