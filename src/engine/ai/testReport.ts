/**
 * A test run, read from what its runner printed (M91.10, Q11). Pure: no DOM,
 * no store, no IPC.
 *
 * Nothing structured comes back from a shell, so the TestResults element
 * reads a Bash call's output, and only its tail survives: runners print their
 * summary last, and the fold keeps the last 2000 characters of each stream.
 * Totals come only from the runner's own final summary. Output without one
 * is no report at all, and the view draws the terminal text instead, so a run
 * nobody counted never reads "0 failed" (CV-05). Everything else is what is
 * still visible: the cases, and the failures, `cut` when the summary counted
 * more of them than the tail still shows.
 *
 * Vitest, jest, pytest and Playwright print one summary for the whole run.
 * Cargo prints one per test binary and go test prints none with counts, so
 * theirs total a run only when nothing was cut from its head: cargo's from
 * every binary's `test result:` line, go's from the line `-v` prints for
 * each test.
 */

import type { ShellResultData } from './types';
import { terminalLines } from './terminalText';

export type TestRunner = 'vitest' | 'jest' | 'cargo' | 'pytest' | 'go' | 'playwright';

export type TestStatus = 'passed' | 'failed' | 'skipped';

/** Where a failure was raised, as the runner printed it. */
export interface TestLocation {
  file: string;
  line?: number;
  column?: number;
}

export interface TestCase {
  name: string;
  status: TestStatus;
  durationMs?: number;
  /** The first line of a failed case's error, where the runner printed one
   * beside the case. */
  message?: string;
}

/** Cases as the runner grouped them: a test file, a go package. */
export interface TestSuite {
  name: string;
  cases: TestCase[];
}

export interface TestFailure {
  name: string;
  /** The first line of its error. */
  message?: string;
  location?: TestLocation;
}

export interface TestTotals {
  passed: number;
  failed: number;
  /** Skipped, todo, ignored, expected to fail, or never run. */
  skipped: number;
  /** Every test the summary counted: the runner's own total where it prints
   * one. */
  total: number;
  durationMs?: number;
  /** Test files as vitest's summary counts them, or suites as jest's does. A
   * file that failed to load fails here and in no test count. */
  files?: { passed: number; failed: number; total: number };
  /** Failures outside any test that the summary reports: vitest's unhandled
   * errors, Playwright's errors outside tests, a go package that failed with
   * no failing test (a build failure, a timeout). */
  errors?: number;
}

export interface TestReport {
  runner: TestRunner;
  totals: TestTotals;
  /** The cases still visible, where the runner names their groups. Their
   * count is never a total. */
  suites?: TestSuite[];
  /** The failing tests still visible, in the order printed. */
  failures: TestFailure[];
  /** The summary counted more failures than are still visible: the view says
   * it shows N of M. */
  cut: boolean;
}

/**
 * The report in `output`, the tail of a test command's output, or null when
 * it holds no final summary that totals the run. `truncated` says its head
 * was cut, so its first line is a fragment and is not read.
 */
export function parseTestReport(
  output: string,
  options: { truncated?: boolean } = {},
): TestReport | null {
  const truncated = options.truncated === true;
  const lines = terminalLines(output);
  if (truncated) lines.shift();
  return readRun(lines, truncated);
}

/** The characters the fold keeps of each shell stream (§3.1). */
const SHELL_TAIL_CHARS = 2000;

/** A shell call's report: its two streams read as one output. */
export function testReportOf(shell: ShellResultData): TestReport | null {
  const lines = [shell.stdout, shell.stderr].flatMap((stream) => {
    const streamLines = terminalLines(stream);
    // One flag covers both streams, but only one as long as the fold keeps can
    // have been cut, and a cut one starts mid-line.
    if (shell.truncated && stream.length >= SHELL_TAIL_CHARS) streamLines.shift();
    return streamLines;
  });
  return readRun(lines, shell.truncated);
}

/** A runner's last summary in the output: where it is, and the report it
 * makes, null when that summary cannot total the run. */
interface Found {
  at: number;
  report: TestReport | null;
}

type Reader = (lines: readonly string[], truncated: boolean) => Found | null;

/** The run whose summary printed last is the one the output reports. */
function readRun(lines: readonly string[], truncated: boolean): TestReport | null {
  const readers: Reader[] = [readVitest, readJest, readCargo, readPytest, readGo, readPlaywright];
  let last: Found | null = null;
  for (const read of readers) {
    const found = read(lines, truncated);
    if (found !== null && (last === null || found.at > last.at)) last = found;
  }
  return last?.report ?? null;
}

function lastIndex(lines: readonly string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i])) return i;
  return -1;
}

/** "2 failed | 3 passed | 1 todo", split on `separator`, as a count per
 * word; null when a part is not a count. */
function countsOf(text: string, separator: string): Map<string, number> | null {
  const counts = new Map<string, number>();
  if (text.trim() === '') return counts;
  for (const part of text.split(separator)) {
    const m = /^(\d+) ([a-z][a-z ]*)$/.exec(part.trim());
    if (m === null) return null;
    counts.set(m[2], (counts.get(m[2]) ?? 0) + Number(m[1]));
  }
  return counts;
}

function sum(counts: ReadonlyMap<string, number>, ...words: string[]): number {
  return words.reduce((n, word) => n + (counts.get(word) ?? 0), 0);
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** "417ms", "1.39s", "0.512 s", "1m 15.3s" in milliseconds; undefined for
 * anything else. */
function parseDuration(text: string): number | undefined {
  let ms = 0;
  for (const part of text.trim().split(/\s+(?=\d)/)) {
    const m = /^(\d+(?:\.\d+)?) ?(ms|s|m|h|d)$/.exec(part);
    if (m === null) return undefined;
    ms += Number(m[1]) * UNIT_MS[m[2]];
  }
  return Math.round(ms);
}

function locationOf(file: string, line?: string, column?: string): TestLocation {
  const location: TestLocation = { file };
  if (line !== undefined) location.line = Number(line);
  if (column !== undefined) location.column = Number(column);
  return location;
}

/** Failures keyed by test, so one printed twice (a status line, then a
 * detail block) is one failure holding both halves. */
function failureBook() {
  const byKey = new Map<string, TestFailure>();
  return {
    add(key: string, name: string, message?: string, location?: TestLocation) {
      let failure = byKey.get(key);
      if (failure === undefined) {
        failure = { name };
        byKey.set(key, failure);
      }
      if (failure.message === undefined && message !== undefined) failure.message = message;
      if (
        location !== undefined &&
        (failure.location === undefined ||
          (failure.location.line === undefined && location.line !== undefined))
      )
        failure.location = location;
    },
    list: (): TestFailure[] => [...byKey.values()],
  };
}

function suiteBook() {
  const bySuite = new Map<string, TestCase[]>();
  const casesOf = (suite: string) => {
    let cases = bySuite.get(suite);
    if (cases === undefined) bySuite.set(suite, (cases = []));
    return cases;
  };
  return {
    add: (suite: string, testCase: TestCase) => casesOf(suite).push(testCase),
    /** A retry's case stands in for the attempt before it. */
    replace(suite: string, testCase: TestCase) {
      const cases = casesOf(suite);
      const at = cases.findIndex((c) => c.name === testCase.name);
      if (at === -1) cases.push(testCase);
      else cases[at] = testCase;
    },
    list: (): TestSuite[] | undefined =>
      bySuite.size === 0 ? undefined : [...bySuite].map(([name, cases]) => ({ name, cases })),
  };
}

function report(
  runner: TestRunner,
  totals: TestTotals,
  failures: TestFailure[],
  suites: TestSuite[] | undefined,
): TestReport {
  const out: TestReport = { runner, totals, failures, cut: failures.length < totals.failed };
  if (suites !== undefined) out.suites = suites;
  return out;
}

// ---------------------------------------------------------------------------
// Vitest: ` Tests  2 failed | 3 passed | 1 todo (6)`, Test Files above it.
// ---------------------------------------------------------------------------

const VITEST_TESTS = /^\s*Tests {2}(\d.*?) \((\d+)\)\s*$/;
const VITEST_FILES = /^\s*Test Files {2}(\d.*?) \((\d+)\)\s*$/;
const VITEST_ERRORS = /^\s*Errors {2}(\d+) errors?\s*$/;
const VITEST_DURATION = /^\s*Duration {2}(\S+)/;
/** ` ❯ src/a.test.ts (5 tests | 1 failed) 5ms`: a file the default reporter lists. */
const VITEST_FILE = /^ [✓❯×↓] (?:\|[^|]+\| )?(\S+) \(\d+ tests?[^)]*\)/u;
/** `   × cart > adds 4ms`: a case listed under its file. */
const VITEST_CASE = /^ {3,}([✓×↓]) (.+?)(?: (\d+)ms)?$/u;
/** ` × src/a.test.ts > cart > adds 4ms`: a case as the verbose reporter prints it. */
const VITEST_VERBOSE = /^ ([✓×↓]) (?:\|[^|]+\| )?(\S+) > (.+?)(?: (\d+)ms)?$/u;
/** `     → expected 2 to be 3`: the failed case above's error. */
const VITEST_ARROW = /^ {3,}→ (.+)$/u;
const VITEST_FAIL = /^ FAIL {2}(?:\|[^|]+\| )?(\S+) > (.+)$/;
const VITEST_SECTION = /^⎯+ (\S.*?) ⎯+$/u;
const VITEST_RULE = /^⎯{3}/u;
/** ` ❯ src/a.test.ts:6:19`, or ` ❯ fn src/a.ts:6:19`: where an error was raised. */
const VITEST_AT = /^ ❯ (?:\S+ )?(\S+?):(\d+):(\d+)$/u;

const VITEST_STATUS: Record<string, TestStatus> = { '✓': 'passed', '×': 'failed', '↓': 'skipped' };

function readVitest(lines: readonly string[]): Found | null {
  const at = lastIndex(lines, (line) => {
    const m = VITEST_TESTS.exec(line);
    return m !== null && countsOf(m[1], ' | ') !== null;
  });
  const summary = at === -1 ? null : VITEST_TESTS.exec(lines[at]);
  const counts = summary === null ? null : countsOf(summary[1], ' | ');
  if (summary === null || counts === null) return null;
  const totals: TestTotals = {
    passed: sum(counts, 'passed'),
    failed: sum(counts, 'failed'),
    skipped: sum(counts, 'skipped', 'todo'),
    total: Number(summary[2]),
  };
  // Test Files prints just above Tests; Errors, Start at and Duration below.
  for (const line of lines.slice(Math.max(0, at - 2), at)) {
    const files = VITEST_FILES.exec(line);
    const fileCounts = files === null ? null : countsOf(files[1], ' | ');
    if (files !== null && fileCounts !== null)
      totals.files = {
        passed: sum(fileCounts, 'passed'),
        failed: sum(fileCounts, 'failed'),
        total: Number(files[2]),
      };
  }
  for (const line of lines.slice(at + 1, at + 5)) {
    const errors = VITEST_ERRORS.exec(line);
    if (errors !== null) totals.errors = Number(errors[1]);
    const duration = VITEST_DURATION.exec(line);
    const ms = duration === null ? undefined : parseDuration(duration[1]);
    if (ms !== undefined) totals.durationMs = ms;
  }

  const failures = failureBook();
  const suites = suiteBook();
  /** The file whose cases the default reporter is listing. */
  let file: string | null = null;
  let section: 'tests' | 'suites' | 'errors' | null = null;
  /** A detail block, from its FAIL lines to the next rule: vitest prints one
   * error once under every test that failed with it. */
  let block: {
    tests: { key: string; name: string; file: string }[];
    message?: string;
    at: TestLocation[];
  } | null = null;
  /** The failed case an arrow line would belong to. */
  let failed: { key: string; testCase: TestCase } | null = null;
  /** The arrow lines' errors, which a failure takes only when no detail
   * block printed its error in full (with its type) for it. */
  const arrows = new Map<string, TestCase>();

  const closeBlock = () => {
    if (block === null) return;
    const { message, at } = block;
    for (const test of block.tests) {
      const where = at.find((location) => location.file === test.file) ?? at[0];
      failures.add(test.key, test.name, message, where);
    }
    block = null;
  };
  /** A listed case, and the failure an arrow line below it would explain. */
  const addCase = (caseFile: string, marker: string, name: string, ms: string | undefined) => {
    const testCase: TestCase = { name, status: VITEST_STATUS[marker] };
    if (ms !== undefined && marker !== '↓') testCase.durationMs = Number(ms);
    suites.add(caseFile, testCase);
    if (testCase.status !== 'failed') return null;
    const key = `${caseFile} > ${name}`;
    failures.add(key, name, undefined, { file: caseFile });
    return { key, testCase };
  };

  for (const line of lines) {
    const heading = VITEST_SECTION.exec(line);
    if (heading !== null) {
      closeBlock();
      section = heading[1].startsWith('Failed Tests')
        ? 'tests'
        : heading[1].startsWith('Failed Suites')
          ? 'suites'
          : 'errors';
      continue;
    }
    if (VITEST_RULE.test(line)) {
      closeBlock();
      continue;
    }
    if (line.startsWith(' FAIL ')) {
      const fail = VITEST_FAIL.exec(line);
      // A suite that failed outside its tests (a file that did not load) is
      // counted by Test Files, never by Tests.
      const test = fail !== null && section !== 'suites' && section !== 'errors';
      const sharesError = block !== null && block.message === undefined && block.at.length === 0;
      if (!(test && sharesError)) closeBlock();
      if (fail !== null && test) {
        const [, failFile, name] = fail;
        const key = `${failFile} > ${name}`;
        failures.add(key, name, undefined, { file: failFile });
        block ??= { tests: [], at: [] };
        block.tests.push({ key, name, file: failFile });
      }
      continue;
    }
    if (block !== null) {
      const where = VITEST_AT.exec(line);
      if (where !== null) block.at.push(locationOf(where[1], where[2], where[3]));
      else if (block.message === undefined && line.trim() !== '') block.message = line.trim();
      continue;
    }
    const arrow = VITEST_ARROW.exec(line);
    if (arrow !== null && failed !== null) {
      failed.testCase.message = arrow[1].trim();
      arrows.set(failed.key, failed.testCase);
      failed = null;
      continue;
    }
    failed = null;
    const fileLine = VITEST_FILE.exec(line);
    if (fileLine !== null) {
      file = fileLine[1];
      continue;
    }
    const verbose = VITEST_VERBOSE.exec(line);
    if (verbose !== null) {
      failed = addCase(verbose[2], verbose[1], verbose[3], verbose[4]);
      continue;
    }
    const caseLine = VITEST_CASE.exec(line);
    if (caseLine !== null && file !== null)
      failed = addCase(file, caseLine[1], caseLine[2], caseLine[3]);
  }
  closeBlock();
  for (const [key, testCase] of arrows) failures.add(key, testCase.name, testCase.message);
  return { at, report: report('vitest', totals, failures.list(), suites.list()) };
}

// ---------------------------------------------------------------------------
// Jest: `Tests:       1 failed, 2 passed, 3 total`, Test Suites above it.
// ---------------------------------------------------------------------------

const JEST_TESTS = /^Tests:\s+((?:\d+ [a-z]+, )*)(\d+) total\s*$/;
const JEST_SUITES = /^Test Suites:\s+((?:\d+ [a-z]+, )*)(\d+)(?: of \d+)? total\s*$/;
const JEST_TIME = /^Time:\s+(\d+(?:\.\d+)? ?m?s)\b/;
const JEST_FILE = /^ (?:FAIL|PASS) {1,2}(\S+)/;
/** `    ✕ adds (3 ms)`: a case the verbose reporter lists, indented two more
 * spaces for each describe around it. */
const JEST_CASE = /^ {2,}([✓✕○✎]) (?:(?:skipped|todo) )?(.+?)(?: \((\d+(?:\.\d+)?) ?(m?s)\))?$/u;
/** `  ● sum › adds`: a failed test's detail block. */
const JEST_FAILURE = /^ {2}● (.+)$/u;
const JEST_AT = /^\s+at (?:.+? \()?(.+?):(\d+):(\d+)\)?$/;

const JEST_STATUS: Record<string, TestStatus> = {
  '✓': 'passed',
  '✕': 'failed',
  '○': 'skipped',
  '✎': 'skipped',
};

function readJest(lines: readonly string[]): Found | null {
  const at = lastIndex(lines, (line) => JEST_TESTS.test(line));
  const summary = at === -1 ? null : JEST_TESTS.exec(lines[at]);
  const counts = summary === null ? null : countsOf(summary[1].replace(/, $/, ''), ', ');
  if (summary === null || counts === null) return null;
  const totals: TestTotals = {
    passed: sum(counts, 'passed'),
    failed: sum(counts, 'failed'),
    skipped: sum(counts, 'skipped', 'todo'),
    total: Number(summary[2]),
  };
  for (const line of lines.slice(Math.max(0, at - 2), at)) {
    const suitesLine = JEST_SUITES.exec(line);
    const suiteCounts =
      suitesLine === null ? null : countsOf(suitesLine[1].replace(/, $/, ''), ', ');
    if (suitesLine !== null && suiteCounts !== null)
      totals.files = {
        passed: sum(suiteCounts, 'passed'),
        failed: sum(suiteCounts, 'failed'),
        total: Number(suitesLine[2]),
      };
  }
  for (const line of lines.slice(at + 1, at + 4)) {
    const time = JEST_TIME.exec(line);
    const ms = time === null ? undefined : parseDuration(time[1]);
    if (ms !== undefined) totals.durationMs = ms;
  }

  const failures = failureBook();
  const suites = suiteBook();
  let file: string | null = null;
  /** A failed test's detail block; null in a Console block. */
  let block: { key: string; name: string; message?: string; location?: TestLocation } | null = null;
  const closeBlock = () => {
    if (block !== null) failures.add(block.key, block.name, block.message, block.location);
    block = null;
  };

  for (const line of lines) {
    const fileLine = JEST_FILE.exec(line);
    if (fileLine !== null) {
      closeBlock();
      file = fileLine[1];
      continue;
    }
    if (/^(?:Summary of all failing tests|Test Suites:|Tests:)/.test(line)) {
      closeBlock();
      continue;
    }
    const header = JEST_FAILURE.exec(line);
    if (header !== null) {
      closeBlock();
      const name = header[1].trim();
      // Console output and a suite that never ran sit in the same blocks.
      if (name !== 'Console' && !name.startsWith('Test suite failed to run')) {
        block = { key: `${file ?? ''} › ${name}`, name };
        failures.add(block.key, name);
      }
      continue;
    }
    if (block !== null) {
      const where = JEST_AT.exec(line);
      if (where !== null) block.location ??= locationOf(where[1], where[2], where[3]);
      else if (block.message === undefined && line.trim() !== '') block.message = line.trim();
      continue;
    }
    const caseLine = JEST_CASE.exec(line);
    if (caseLine !== null && file !== null) {
      const [, marker, name, amount, unit] = caseLine;
      const testCase: TestCase = { name, status: JEST_STATUS[marker] };
      if (amount !== undefined) testCase.durationMs = Math.round(Number(amount) * UNIT_MS[unit]);
      suites.add(file, testCase);
    }
  }
  closeBlock();
  return { at, report: report('jest', totals, failures.list(), suites.list()) };
}

// ---------------------------------------------------------------------------
// Cargo: one `test result:` line per test binary.
// ---------------------------------------------------------------------------

const CARGO_RESULT =
  /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; \d+ filtered out(?:; finished in (\d+(?:\.\d+)?)s)?/;
const CARGO_RUNNING = /^running \d+ tests?$/;
const CARGO_CASE = /^test (.+) \.\.\. (ok|FAILED|ignored\b.*)$/;
const CARGO_STDOUT = /^---- (.+) stdout ----$/;
const CARGO_PANIC = /^thread '.*'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/;
const CARGO_PANIC_QUOTED = /^thread '.*'(?: \(\d+\))? panicked at '(.*)', (.+?):(\d+):(\d+)$/;

function readCargo(lines: readonly string[], truncated: boolean): Found | null {
  const at = lastIndex(lines, (line) => CARGO_RESULT.test(line));
  if (at === -1) return null;
  // A binary whose lines were cut away would be missing from the sum.
  if (truncated) return { at, report: null };
  const totals: TestTotals = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let durationMs: number | undefined = 0;
  /** A binary started and has not reported: it crashed, or is still going. */
  let running = false;
  for (const line of lines) {
    if (CARGO_RUNNING.test(line)) {
      if (running) return { at, report: null };
      running = true;
    }
    const result = CARGO_RESULT.exec(line);
    if (result === null) continue;
    running = false;
    totals.passed += Number(result[1]);
    totals.failed += Number(result[2]);
    totals.skipped += Number(result[3]);
    durationMs =
      durationMs === undefined || result[4] === undefined
        ? undefined
        : durationMs + Number(result[4]) * 1000;
  }
  if (running) return { at, report: null };
  totals.total = totals.passed + totals.failed + totals.skipped;
  if (durationMs !== undefined) totals.durationMs = Math.round(durationMs);

  const failures = failureBook();
  /** The test whose captured output is being read, and whether its panic
   * message is the next line. */
  let output: string | null = null;
  let messageNext = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const caseLine = CARGO_CASE.exec(line);
    if (caseLine !== null) {
      output = null;
      if (caseLine[2] === 'FAILED') failures.add(caseLine[1], caseLine[1]);
      continue;
    }
    const stdout = CARGO_STDOUT.exec(line);
    if (stdout !== null) {
      output = stdout[1];
      messageNext = false;
      continue;
    }
    if (line === 'failures:') {
      output = null;
      for (let j = i + 1; j < lines.length && /^ {4}\S/.test(lines[j]); j++)
        failures.add(lines[j].trim(), lines[j].trim());
      continue;
    }
    if (output === null) continue;
    if (messageNext) {
      if (line.trim() === '') continue;
      failures.add(output, output, line.trim());
      messageNext = false;
      continue;
    }
    const panic = CARGO_PANIC.exec(line);
    if (panic !== null) {
      failures.add(output, output, undefined, locationOf(panic[1], panic[2], panic[3]));
      messageNext = true;
      continue;
    }
    const quoted = CARGO_PANIC_QUOTED.exec(line);
    if (quoted !== null)
      failures.add(output, output, quoted[1], locationOf(quoted[2], quoted[3], quoted[4]));
  }
  return { at, report: report('cargo', totals, failures.list(), undefined) };
}

// ---------------------------------------------------------------------------
// Pytest: `===== 1 failed, 9 passed, 1 error in 0.42s =====`.
// ---------------------------------------------------------------------------

const PYTEST_SUMMARY =
  /^(?:=+ )?(no tests ran|\d+ [a-z]+(?:, \d+ [a-z]+)*) in (\d+(?:\.\d+)?)s(?: \(\d+:\d{2}:\d{2}\))?(?: =+)?\s*$/;
/** `FAILED tests/test_a.py::test_x - assert 3 == 4`: the short summary. */
const PYTEST_SHORT = /^(FAILED|ERROR) (.+?)(?: - (.*))?$/;
/** `_____ test_x _____`: a failure's detail block. */
const PYTEST_HEADER = /^_{3,} (.+?) _{3,}$/;
/** `tests/test_a.py:9: AssertionError`, or bare `tests/test_a.py:9:` for an
 * outer frame: where a traceback ran. */
const PYTEST_WHERE = /^(\S+\.py):(\d+):(?: .*)?$/;
/** `tests/test_a.py::test_x PASSED [ 50%]`: a case `-v` lists. */
const PYTEST_CASE = /^(\S+?\.py)::(\S+) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/;

const PYTEST_STATUS: Record<string, TestStatus> = {
  PASSED: 'passed',
  XPASS: 'passed',
  FAILED: 'failed',
  ERROR: 'failed',
  SKIPPED: 'skipped',
  XFAIL: 'skipped',
};

/** The words pytest's summary counts in. Any other word ("3 files in 0.2s")
 * is some other tool's line, which must never read as a run of none. */
const PYTEST_WORDS = new Set([
  'passed',
  'failed',
  'skipped',
  'deselected',
  'xfailed',
  'xpassed',
  'warning',
  'warnings',
  'error',
  'errors',
  'rerun',
]);

function pytestCounts(line: string): Map<string, number> | null {
  const summary = PYTEST_SUMMARY.exec(line);
  if (summary === null) return null;
  const counts = countsOf(summary[1] === 'no tests ran' ? '' : summary[1], ', ');
  return counts !== null && [...counts.keys()].every((word) => PYTEST_WORDS.has(word))
    ? counts
    : null;
}

function readPytest(lines: readonly string[]): Found | null {
  const at = lastIndex(lines, (line) => pytestCounts(line) !== null);
  const summary = at === -1 ? null : PYTEST_SUMMARY.exec(lines[at]);
  const counts = at === -1 ? null : pytestCounts(lines[at]);
  if (summary === null || counts === null) return null;
  // An expected failure counts as skipped and an unexpected pass as passed,
  // as pytest's own JUnit report has them; an error fails its test.
  const passed = sum(counts, 'passed', 'xpassed');
  const failed = sum(counts, 'failed', 'error', 'errors');
  const skipped = sum(counts, 'skipped', 'xfailed');
  const totals: TestTotals = {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    durationMs: Math.round(Number(summary[2]) * 1000),
  };

  /** Each detail block's tracebacks, by the test its header names. */
  const where = new Map<string, TestLocation[]>();
  let header: string | null = null;
  const suites = suiteBook();
  for (const line of lines) {
    const blockHeader = PYTEST_HEADER.exec(line);
    if (blockHeader !== null) {
      header = blockHeader[1].replace(/^ERROR (?:at (?:setup|teardown) of|collecting) /, '');
      continue;
    }
    if (/^=+ /.test(line)) header = null;
    const location = PYTEST_WHERE.exec(line);
    if (location !== null && header !== null) {
      const seen = where.get(header) ?? [];
      seen.push(locationOf(location[1], location[2]));
      where.set(header, seen);
    }
    const caseLine = PYTEST_CASE.exec(line);
    if (caseLine !== null)
      suites.add(caseLine[1], { name: caseLine[2], status: PYTEST_STATUS[caseLine[3]] });
  }

  const failures = failureBook();
  for (const line of lines) {
    const short = PYTEST_SHORT.exec(line);
    if (short === null) continue;
    const [, kind, nodeId, message] = short;
    const file = nodeId.split('::')[0];
    const name = nodeId.includes('::') ? nodeId.slice(file.length + 2) : nodeId;
    // A traceback in the test's own file says where the test failed; the
    // last one is the innermost.
    const tracebacks = where.get(name.replaceAll('::', '.')) ?? [];
    const own = tracebacks.filter((location) => location.file === file);
    const location =
      own.at(-1) ?? tracebacks.at(-1) ?? (file.endsWith('.py') ? { file } : undefined);
    // A test that failed and then errored in its teardown counts twice.
    failures.add(`${kind} ${nodeId}`, name, message?.trim() || undefined, location);
  }
  return { at, report: report('pytest', totals, failures.list(), suites.list()) };
}

// ---------------------------------------------------------------------------
// Go: `ok`/`FAIL` per package; `--- PASS: TestX (0.00s)` per test under -v.
// ---------------------------------------------------------------------------

const GO_PACKAGE = /^(ok|FAIL|\?)\s+(\S+)\s+(?:\d+(?:\.\d+)?s|\(cached\)|\[[^\]]+\])/;
const GO_RESULT = /^--- (PASS|FAIL|SKIP): (\S+) \((\d+(?:\.\d+)?)s\)$/;
const GO_RUN = /^=== (?:RUN|CONT|NAME) +(\S+)$/;
const GO_LOG = /^\s+(\S+\.go):(\d+): (.*)$/;

const GO_STATUS: Record<string, TestStatus> = { PASS: 'passed', FAIL: 'failed', SKIP: 'skipped' };

/** A failed test's first log line: printed after `=== RUN` and before its
 * result under -v, or indented under the result without it. */
function goLog(lines: readonly string[], from: number, result: number): RegExpExecArray | null {
  for (let i = from + 1; i < result; i++) {
    const log = GO_LOG.exec(lines[i]);
    if (log !== null) return log;
  }
  for (let i = result + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
    const log = GO_LOG.exec(lines[i]);
    if (log !== null) return log;
  }
  return null;
}

function readGo(lines: readonly string[], truncated: boolean): Found | null {
  const at = lastIndex(lines, (line) => GO_PACKAGE.test(line));
  if (at === -1) return null;
  // go test prints no counts. Without -v a passing test prints nothing, and
  // a cut head may have held any number of results.
  if (truncated || !lines.some((line) => GO_RUN.test(line))) return { at, report: null };

  const totals: TestTotals = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let errors = 0;
  const failures: TestFailure[] = [];
  const suites = new Map<string, TestCase[]>();
  /** The results since the last package line, which they belong to. */
  let region: TestCase[] = [];
  const runAt = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const run = GO_RUN.exec(line);
    if (run !== null) {
      runAt.set(run[1], i);
      continue;
    }
    const result = GO_RESULT.exec(line);
    if (result !== null) {
      const [, word, name, seconds] = result;
      const testCase: TestCase = {
        name,
        status: GO_STATUS[word],
        durationMs: Math.round(Number(seconds) * 1000),
      };
      totals[testCase.status] += 1;
      if (testCase.status === 'failed') {
        const log = goLog(lines, runAt.get(name) ?? i, i);
        const failure: TestFailure = { name };
        if (log !== null) {
          testCase.message = log[3].trim();
          failure.message = testCase.message;
          failure.location = locationOf(log[1], log[2]);
        }
        failures.push(failure);
      }
      region.push(testCase);
      continue;
    }
    const pkg = GO_PACKAGE.exec(line);
    if (pkg === null) continue;
    if (region.length > 0) suites.set(pkg[2], region);
    // A package that failed with no failing test failed outside them: it did
    // not build, or a test timed out or panicked before it could report.
    if (pkg[1] === 'FAIL' && !region.some((c) => c.status === 'failed')) errors += 1;
    region = [];
    runAt.clear();
  }
  totals.total = totals.passed + totals.failed + totals.skipped;
  if (errors > 0) totals.errors = errors;
  const suiteList =
    suites.size === 0 ? undefined : [...suites].map(([name, cases]) => ({ name, cases }));
  return { at, report: report('go', totals, failures, suiteList) };
}

// ---------------------------------------------------------------------------
// Playwright: `  1 failed` and its tests, `  2 skipped`, `  8 passed (12.3s)`.
// ---------------------------------------------------------------------------

const PW_COUNT =
  /^ {2}(\d+) (failed|flaky|interrupted|skipped|did not run|passed)(?: \(([^()]+)\))?\s*$/;
const PW_FATAL = /^ {2}(\d+) errors? (?:was|were) not a part of any test\b/;
/** `    [chromium] › a.spec.ts:5:3 › opens ────`: a test the summary lists. */
const PW_ENTRY = /^ {4}(\S.*?)\s*─*\s*$/u;
/** `  1) [chromium] › a.spec.ts:5:3 › opens ────`: a failure's detail block. */
const PW_DETAIL = /^ {2}\d+\) (\S.*?)\s*─*\s*$/u;
/** `  ✘  2 [chromium] › a.spec.ts:5:3 › opens (5.1s)`: a list reporter line. */
const PW_LIST = /^ {2}([✓✘-]) +(?:\d+ +)?(\S.*?)\s*$/u;
const PW_TITLE = /^(?:(\[[^\]]+\]) › )?(\S.*?):(\d+):(\d+) › (.+)$/u;
const PW_RUNNING = /^Running \d+ tests? using \d+ workers?/;

const PW_STATUS: Record<string, TestStatus> = { '✓': 'passed', '✘': 'failed', '-': 'skipped' };

/** A test's title as Playwright prints it: `[project] › file:line:col › path`. */
function playwrightTitle(text: string): { name: string; location: TestLocation } | null {
  const m = PW_TITLE.exec(text);
  if (m === null) return null;
  const [, project, file, line, column, title] = m;
  return {
    name: project === undefined ? title : `${project} › ${title}`,
    location: locationOf(file, line, column),
  };
}

function readPlaywright(lines: readonly string[], truncated: boolean): Found | null {
  const inSummary = (line: string) =>
    PW_COUNT.test(line) || PW_FATAL.test(line) || PW_ENTRY.test(line);
  const at = lastIndex(lines, (line) => PW_COUNT.test(line) || PW_FATAL.test(line));
  if (at === -1) return null;
  let start = at;
  while (start > 0 && inSummary(lines[start - 1])) start -= 1;
  let end = at;
  while (end + 1 < lines.length && PW_ENTRY.test(lines[end + 1])) end += 1;
  const block = lines.slice(start, end + 1);
  // Lines that only look like a summary are not one: Playwright's carries
  // its run's time, or names its tests, or follows its "Running" line.
  const playwright =
    block.some((line) => parseDuration(PW_COUNT.exec(line)?.[3] ?? '') !== undefined) ||
    block.some((line) => playwrightTitle(PW_ENTRY.exec(line)?.[1] ?? '') !== null) ||
    lines.slice(0, start).some((line) => PW_RUNNING.test(line));
  if (!playwright) return null;
  // A summary whose head was cut away has lost counts, maybe all failures.
  // Failed prints first, so a cut that leaves its line leaves all the rest.
  const head = PW_COUNT.exec(block[0]);
  if (head === null || (truncated && start === 0 && head[2] !== 'failed'))
    return { at, report: null };

  const counts = new Map<string, number>();
  let errors = 0;
  let durationMs: number | undefined;
  const failures = failureBook();
  const failed: string[] = [];
  let category: string | null = null;
  for (const line of block) {
    const count = PW_COUNT.exec(line);
    if (count !== null) {
      category = count[2];
      counts.set(category, (counts.get(category) ?? 0) + Number(count[1]));
      if (category === 'passed' && count[3] !== undefined) durationMs = parseDuration(count[3]);
      continue;
    }
    const fatal = PW_FATAL.exec(line);
    if (fatal !== null) {
      errors += Number(fatal[1]);
      category = null;
      continue;
    }
    const entry = PW_ENTRY.exec(line);
    if (entry !== null && category === 'failed') failed.push(entry[1]);
  }

  /** Each detail block's first line, by its header. */
  const messages = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const detail = PW_DETAIL.exec(lines[i]);
    if (detail === null || messages.has(detail[1])) continue;
    for (let j = i + 1; j < lines.length && j < i + 12; j++) {
      const text = lines[j].trim();
      if (text === '' || /^Retry #\d+/.test(text)) continue;
      messages.set(detail[1], text);
      break;
    }
  }
  for (const header of failed) {
    const title = playwrightTitle(header);
    if (title === null) failures.add(header, header, messages.get(header));
    else failures.add(header, title.name, messages.get(header), title.location);
  }

  const suites = suiteBook();
  for (const line of lines.slice(0, start)) {
    const listed = PW_LIST.exec(line);
    if (listed === null) continue;
    const [, marker, rest] = listed;
    let text = rest;
    let ms: number | undefined;
    const timed = / \(([^()]+)\)$/.exec(text);
    if (timed !== null && marker !== '-') {
      ms = parseDuration(timed[1]);
      if (ms !== undefined) text = text.slice(0, timed.index);
    }
    const title = playwrightTitle(text.replace(/ \(retry #\d+\)$/, ''));
    if (title === null) continue;
    const testCase: TestCase = { name: title.name, status: PW_STATUS[marker] };
    if (ms !== undefined) testCase.durationMs = ms;
    suites.replace(title.location.file, testCase);
  }

  const passed = sum(counts, 'passed', 'flaky');
  const failedCount = sum(counts, 'failed');
  // Playwright's own outcome reads an interrupted test as skipped, and a
  // flaky one passed on retry.
  const skipped = sum(counts, 'skipped', 'did not run', 'interrupted');
  const totals: TestTotals = {
    passed,
    failed: failedCount,
    skipped,
    total: passed + failedCount + skipped,
  };
  if (durationMs !== undefined) totals.durationMs = durationMs;
  if (errors > 0) totals.errors = errors;
  return { at, report: report('playwright', totals, failures.list(), suites.list()) };
}
