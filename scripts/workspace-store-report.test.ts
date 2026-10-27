import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import nativeReport from '../docs/superpowers/plans/2026-10-23-m99-store-comparison/adversarial-final.json';
import { checkRustReport, parseReportArgs } from './workspace-store-report';

type Report = typeof nativeReport;
const repo = process.cwd();
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cerebro-m99-report-'));
  roots.push(root);
  // Keep the historical native output immutable. This real-shaped validator
  // fixture copies current source inputs and hashes those exact temporary bytes;
  // it is not a new measurement or proof of the historical compiled provenance.
  const report = structuredClone(nativeReport);
  for (const path of Object.keys(report.sourceDigests) as (keyof typeof report.sourceDigests)[]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = readFileSync(join(repo, path));
    writeFileSync(target, bytes);
    report.sourceDigests[path] = createHash('sha256').update(bytes).digest('hex');
  }
  return { root, report };
}

const invalidEvidence: [string, (report: Report) => void][] = [
  [
    'original bytes changed',
    (r) => {
      r.originalBytesUnchanged = false;
    },
  ],
  [
    'missing original byte evidence',
    (r) => {
      Reflect.deleteProperty(r, 'originalBytesUnchanged');
    },
  ],
  [
    'failed backup',
    (r) => {
      r.stores[0].backupRestore = 'failed';
    },
  ],
  [
    'adopted external bytes',
    (r) => {
      r.stores[1].externalEdit = 'adopted';
    },
  ],
  [
    'missing recovery exercises',
    (r) => {
      r.stores[0].recovery = [];
    },
  ],
  [
    'failed recovery',
    (r) => {
      r.stores[1].recovery[2].outcome = 'failed';
    },
  ],
  [
    'duplicate recovery boundary',
    (r) => {
      r.stores[0].recovery[2] = r.stores[0].recovery[0];
    },
  ],
  [
    'missing backend outcome',
    (r) => {
      Reflect.deleteProperty(r.stores[0], 'backupRestore');
    },
  ],
  [
    'duplicate backend',
    (r) => {
      r.stores[1].backend = 'sidecar';
    },
  ],
  [
    'query count disagreement',
    (r) => {
      r.stores[0].queriedRecords = 0;
    },
  ],
  [
    'converted count disagreement',
    (r) => {
      r.convertedRecords -= 1;
    },
  ],
  [
    'negative retained count',
    (r) => {
      r.retainedRecords = -1;
    },
  ],
  [
    'unsupported scenario size',
    (r) => {
      r.scenario = 'ordinary';
    },
  ],
  [
    'unknown scenario',
    (r) => {
      r.scenario = 'unmeasured';
    },
  ],
  [
    'missing conversion dispositions',
    (r) => {
      r.conversionDispositions = [];
    },
  ],
  [
    'duplicated disposition path',
    (r) => {
      r.conversionDispositions[1] = r.conversionDispositions[0];
    },
  ],
  [
    'false conversion disposition',
    (r) => {
      r.conversionDispositions[0].disposition = 'converted';
    },
  ],
  [
    'missing archive checksum',
    (r) => {
      Reflect.deleteProperty(r.archiveHashes, 'wide.md');
    },
  ],
  [
    'missing requested path',
    (r) => {
      r.inventoryCoverage.requested_paths.pop();
    },
  ],
  [
    'whole vault claim',
    (r) => {
      r.inventoryCoverage.whole_vault = true;
    },
  ],
  [
    'missing timing',
    (r) => {
      Reflect.deleteProperty(r.stores[0].timingsMicros, 'patch_us');
    },
  ],
  [
    'negative timing',
    (r) => {
      r.commonTimingsMicros.inventory = -1;
    },
  ],
  [
    'nonfinite timing',
    (r) => {
      r.stores[0].timingsMicros.patch_us = Infinity;
    },
  ],
  [
    'unsafe timing integer',
    (r) => {
      r.stores[0].timingsMicros.patch_us = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'unavailable timing',
    (r) => {
      Reflect.set(r.stores[1].timingsMicros, 'patch_us', { status: 'unavailable' });
    },
  ],
  [
    'missing context',
    (r) => {
      Reflect.deleteProperty(r, 'context');
    },
  ],
  [
    'missing load context',
    (r) => {
      Reflect.deleteProperty(r.context, 'loadAverage');
    },
  ],
  [
    'invalid load context',
    (r) => {
      r.context.loadAverage = [-1, 0, 0];
    },
  ],
  [
    'missing contention qualifier',
    (r) => {
      Reflect.deleteProperty(r.context, 'concurrency');
    },
  ],
  [
    'performance winner claim',
    (r) => {
      r.performanceDecision = 'sqlite_wins';
    },
  ],
  [
    'unqualified measurements',
    (r) => {
      r.measurementQuality = 'decision_grade';
    },
  ],
  [
    'missing toolchain context',
    (r) => {
      Reflect.deleteProperty(r, 'toolchainPin');
    },
  ],
  [
    'missing ledger evidence',
    (r) => {
      Reflect.deleteProperty(r, 'ledgerEvidence');
    },
  ],
  [
    'missing limitations',
    (r) => {
      r.limitations = [];
    },
  ],
  [
    'unexplained difference',
    (r) => {
      Reflect.set(r, 'semanticDifferences', ['lost value']);
    },
  ],
  [
    'unknown report version',
    (r) => {
      r.format = 2;
    },
  ],
];

describe('Rust workspace comparison report boundary', () => {
  it('requires explicit fixture, output and already-built native test binary paths', () => {
    expect(
      parseReportArgs([
        '--fixture',
        '/tmp/input',
        '--out',
        '/tmp/result',
        '--native-binary',
        '/tmp/native',
      ]),
    ).toEqual({ fixture: '/tmp/input', out: '/tmp/result', nativeBinary: '/tmp/native' });
    expect(() => parseReportArgs(['--fixture', '/tmp/input'])).toThrow(/required/i);
    expect(() => parseReportArgs(['--fixture', '/tmp/a', '--fixture', '/tmp/b'])).toThrow(
      /duplicate/i,
    );
    expect(() => parseReportArgs(['--upload', 'remote'])).toThrow(/unknown/i);
  });
  it('accepts the complete native artifact with its exact source inventory and outcomes', () => {
    const { root, report } = fixture();
    expect(() => checkRustReport(JSON.stringify(report), root)).not.toThrow();
  });
  it('refuses the reviewer truncated-report probe despite one correct source hash', () => {
    const { root, report } = fixture();
    const path = 'src-tauri/src/workspace_migration/comparison.rs';
    expect(() =>
      checkRustReport(
        JSON.stringify({
          format: 1,
          measurementQuality: report.measurementQuality,
          sourceDigests: { [path]: report.sourceDigests[path] },
          semanticDifferences: [],
          stores: [{ backend: 'sidecar' }, { backend: 'sqlite' }],
        }),
        root,
      ),
    ).toThrow();
  });
  it.each(invalidEvidence)('refuses %s before declaring native acceptance', (_label, mutate) => {
    const { root, report } = fixture();
    mutate(report);
    expect(() => checkRustReport(JSON.stringify(report), root)).toThrow();
  });
  it.each(Object.keys(nativeReport.sourceDigests))('refuses omitted compiled source %s', (path) => {
    const { root, report } = fixture();
    Reflect.deleteProperty(report.sourceDigests, path);
    expect(() => checkRustReport(JSON.stringify(report), root)).toThrow(/source/i);
  });
  it('refuses a replacement source key even when its bytes and digest match', () => {
    const { root, report } = fixture();
    const path = 'src-tauri/src/workspace_migration/comparison.rs';
    const replacement = 'src-tauri/src/irrelevant.rs';
    writeFileSync(join(root, replacement), readFileSync(join(root, path)));
    Reflect.set(report.sourceDigests, replacement, report.sourceDigests[path]);
    Reflect.deleteProperty(report.sourceDigests, path);
    expect(() => checkRustReport(JSON.stringify(report), root)).toThrow(/source/i);
  });
  it('rejects stale source bytes and paths outside the repository', () => {
    const { root, report } = fixture();
    writeFileSync(
      join(root, 'src-tauri/src/workspace_migration/comparison.rs'),
      'changed after compilation\n',
    );
    expect(() => checkRustReport(JSON.stringify(report), root)).toThrow(/stale/i);
    const escaped = { ...report, sourceDigests: { '../outside': 'a'.repeat(64) } };
    expect(() => checkRustReport(JSON.stringify(escaped), root)).toThrow(/source/i);
  });
});
