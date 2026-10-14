import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The invariants M32 built into `.github/` (re-landed as M53.1), held on every
 * pre-push. zizmor and actionlint (scanners.yml) cover the same ground, but
 * only for a pull request or a push to main that touches `.github/`, and the
 * zizmor ignores in mac-app.yml switch its cache-poisoning audit off on
 * exactly the lines whose mitigation this file checks. A bad edit fails here
 * before it leaves the machine.
 */

interface Step {
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  permissions?: string | Record<string, string>;
  uses?: string;
  steps?: Step[];
}

interface Workflow {
  on?: unknown;
  permissions?: unknown;
  jobs: Record<string, Job>;
}

const GITHUB = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.github');
const WORKFLOW_DIR = join(GITHUB, 'workflows');

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => {
    const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    return { file, text, doc: parse(text) as Workflow };
  });

function workflow(file: string): Workflow {
  const found = workflows.find((w) => w.file === file);
  if (found === undefined) throw new Error(`.github/workflows/${file} is missing`);
  return found.doc;
}

/** Trigger names, whichever of the three shapes `on:` takes. */
function triggers(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on !== null && typeof on === 'object') return Object.keys(on);
  return [];
}

function steps(doc: Workflow): { job: string; step: Step }[] {
  return Object.entries(doc.jobs).flatMap(([job, j]) =>
    (j.steps ?? []).map((step) => ({ job, step })),
  );
}

/** Every remote action or reusable workflow a workflow names. */
function usesOf(doc: Workflow): string[] {
  return [
    ...Object.values(doc.jobs).flatMap((job) => (job.uses === undefined ? [] : [job.uses])),
    ...steps(doc).flatMap(({ step }) => (step.uses === undefined ? [] : [step.uses])),
  ].filter((ref) => !ref.startsWith('./'));
}

describe('every workflow', () => {
  it('finds the workflows it guards', () => {
    expect(workflows.map((w) => w.file)).toEqual(
      expect.arrayContaining(['cargo-deny.yml', 'mac-app.yml', 'scanners.yml']),
    );
  });

  it('pins every action to a full commit, never to a tag a push can move', () => {
    const offenders = workflows.flatMap(({ file, doc }) =>
      usesOf(doc)
        .filter((ref) => !/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(ref))
        .map((ref) => `${file}: ${ref}`),
    );
    expect(offenders).toEqual([]);
  });

  it('writes the version beside every pin, so a reviewer can read a bump', () => {
    for (const { file, text, doc } of workflows) {
      const lines = text
        .split('\n')
        .filter((line) => /^\s*(-\s+)?uses:\s*['"]?(?!\.\/)\S/.test(line));
      // The line scan must see every pin the parser sees, or it proves nothing.
      expect(lines, file).toHaveLength(usesOf(doc).length);
      expect(
        lines.filter((line) => !/@[0-9a-f]{40}['"]?\s+#\s*v\d/.test(line)),
        file,
      ).toEqual([]);
    }
  });

  it('never triggers on pull_request_target', () => {
    for (const { file, doc } of workflows) {
      expect(triggers(doc.on), file).not.toContain('pull_request_target');
    }
  });

  it('declares a read-only token at the top level', () => {
    for (const { file, doc } of workflows) {
      expect(doc.permissions, file).toEqual({ contents: 'read' });
    }
  });

  it('grants write only to the jobs that publish', () => {
    const grants = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs).flatMap(([job, { permissions }]) => {
        if (permissions === undefined) return [];
        if (typeof permissions === 'string') {
          return permissions === 'read-all' ? [] : [`${file} ${job} ${permissions}`];
        }
        return Object.entries(permissions)
          .filter(([, level]) => level === 'write')
          .map(([scope]) => `${file} ${job} ${scope}`);
      }),
    );
    expect(grants.sort()).toEqual([
      'mac-app.yml build attestations',
      'mac-app.yml build contents',
      'mac-app.yml build id-token',
      'scanners.yml zizmor security-events',
    ]);
  });

  it('checks out without leaving the token on disk', () => {
    const checkouts = workflows.flatMap(({ file, doc }) =>
      steps(doc)
        .filter(({ step }) => step.uses?.startsWith('actions/checkout@'))
        .map(({ job, step }) => ({ where: `${file} ${job}`, step })),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    expect(
      checkouts
        .filter(({ step }) => step.with?.['persist-credentials'] !== false)
        .map((c) => c.where),
    ).toEqual([]);
  });
});

describe('mac-app.yml', () => {
  const doc = workflow('mac-app.yml');

  it('keeps quality and e2e under the names the protect-main ruleset requires', () => {
    for (const id of ['quality', 'e2e']) {
      expect(doc.jobs[id], id).toBeDefined();
      // A `name:` replaces the job id as the check context, and the ruleset
      // would then wait forever on a check that never reports.
      expect(doc.jobs[id].name ?? id).toBe(id);
      expect(doc.jobs[id].if, `${id} must run on every push`).toBeUndefined();
    }
  });

  it('runs on a push to any branch and to a v* tag, with no filter to skip one', () => {
    const push = (doc.on as { push?: Record<string, unknown> }).push;
    expect(push?.branches).toContain('**');
    expect(push?.tags).toContain('v*');
    // A skipped run leaves a required check pending, and the PR never merges.
    for (const filter of ['paths', 'paths-ignore', 'branches-ignore', 'tags-ignore']) {
      expect(push, filter).not.toHaveProperty(filter);
    }
  });

  it('has no pull_request trigger: a PR binds to its head commit push run', () => {
    // SETUP.md (fork-PR box) and this file's header both say pushes only.
    expect(triggers(doc.on)).not.toContain('pull_request');
  });

  it('builds only on main, v* tags and manual dispatch, after both gates', () => {
    const build = doc.jobs.build;
    expect(build.needs).toEqual(expect.arrayContaining(['quality', 'e2e']));
    expect(build.if).toBe(
      "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    );
  });

  it('restores no cache into a release, which is why its zizmor ignores are true', () => {
    const build = doc.jobs.build.steps ?? [];
    const setupNode = build.filter((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setupNode).toHaveLength(1);
    expect(setupNode[0].with ?? {}).not.toHaveProperty('cache');
    const rustCache = build.filter((s) => s.uses?.startsWith('Swatinem/rust-cache@'));
    expect(rustCache).toHaveLength(1);
    expect(rustCache[0].if).toBe("${{ !startsWith(github.ref, 'refs/tags/') }}");
  });

  it('attests and publishes on a v* tag only', () => {
    const build = doc.jobs.build.steps ?? [];
    for (const action of ['actions/attest-build-provenance@', 'softprops/action-gh-release@']) {
      const step = build.find((s) => s.uses?.startsWith(action));
      expect(step, action).toBeDefined();
      expect(step?.if, action).toBe("startsWith(github.ref, 'refs/tags/v')");
    }
  });
});

describe('dependabot.yml', () => {
  it('keeps the action pins and both lockfiles fresh', () => {
    const doc = parse(readFileSync(join(GITHUB, 'dependabot.yml'), 'utf8')) as {
      updates: { 'package-ecosystem': string; directory: string }[];
    };
    expect(doc.updates.map((u) => `${u['package-ecosystem']} ${u.directory}`)).toEqual(
      expect.arrayContaining(['github-actions /', 'npm /', 'cargo /src-tauri']),
    );
  });
});
