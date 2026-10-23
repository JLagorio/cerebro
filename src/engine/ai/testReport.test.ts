import { describe, expect, it } from 'vitest';
import { parseTestReport, testReportOf, type TestReport } from './testReport';

/**
 * The logs below are real runner output (vitest 3.2, cargo on Rust 1.95,
 * go 1.25, Playwright 1.61, recorded 2026-10-22 with home paths shortened),
 * or jest 29 and pytest 8 output in their documented format. Colour codes
 * are written as `\u001b` escapes (CV-13).
 */

const ESC = '\u001b';
const RULE = '⎯'.repeat(24);

/** `vitest run` on three files: two with failures, one that does not load. */
const VITEST_STDOUT = `
 RUN  v3.2.7 /Users/me/shop

 ❯ src/cart.test.ts (5 tests | 1 failed | 2 skipped) 5ms
   ✓ cart > adds an item 1ms
   ✓ cart > removes an item 0ms
   × cart > applies a discount code 4ms
     → expected 90 to be 80 // Object.is equality
   ↓ cart > ships abroad
   ↓ cart > handles gift cards
 ❯ src/payment.test.ts (2 tests | 1 failed) 7ms
   ✓ payment > charges the saved card 1ms
   × payment > retries a declined card 5ms
     → expected { attempts: 1 } to deeply equal { attempts: 2 }

 Test Files  3 failed (3)
      Tests  2 failed | 3 passed | 1 skipped | 1 todo (7)
   Start at  08:40:07
   Duration  417ms (transform 97ms, setup 0ms, collect 62ms, tests 12ms, environment 0ms, prepare 257ms)
`;

const VITEST_STDERR = `
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/broken.test.ts [ src/broken.test.ts ]
Error: Cannot find module './nowhere' imported from '/Users/me/shop/src/broken.test.ts'
 ❯ src/broken.test.ts:1:1
      1| import { missing } from './nowhere';
       | ^

${RULE}[1/3]⎯


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/cart.test.ts > cart > applies a discount code
AssertionError: expected 90 to be 80 // Object.is equality

${ESC}[32m- Expected${ESC}[39m
${ESC}[31m+ Received${ESC}[39m

${ESC}[32m- 80${ESC}[39m
${ESC}[31m+ 90${ESC}[39m

 ❯ src/cart.test.ts:6:19
      4|   it('applies a discount code', () => {
      5|     const total = 90;
      6|     expect(total).toBe(80);
       |                   ^
      7|   });

${RULE}[2/3]⎯

 FAIL  src/payment.test.ts > payment > retries a declined card
AssertionError: expected { attempts: 1 } to deeply equal { attempts: 2 }

 ❯ src/payment.test.ts:4:29
      3|   it('retries a declined card', () => {
      4|     expect({ attempts: 1 }).toEqual({ attempts: 2 });
       |                             ^

${RULE}[3/3]⎯
`;

const pad = (n: number) => String(n).padStart(2, '0');

/** The files that fail in `vitest300`, and the case that fails in each. */
const FAILING = new Map([
  [3, 2],
  [7, 3],
  [11, 8],
  [18, 9],
  [22, 1],
  [25, 6],
  [29, 5],
  [30, 10],
]);

/**
 * A 300-test vitest run as one stream (`2>&1`), laid out as vitest 3.2 laid
 * out a real one: 30 files of 10 cases in the order they finished, the cases
 * of each failing file, the failure details by file, then the summary.
 */
function vitest300(): string {
  const finished = [2, 4, 5, 18, 29, 6, 7, 3, 1, 8, 9, 10, 13, 15, 14, 12, 16, 11, 21, 20];
  finished.push(22, 25, 17, 23, 24, 26, 19, 28, 27, 30);
  const failing = FAILING;
  const caseLine = (k: number, plus = '') =>
    `   it('case ${k}', () => { expect(${k}).toBe(${k}${plus}); });`;
  const out = ['', ' RUN  v3.2.7 /Users/me/shop', ''];
  for (const f of finished) {
    const file = `src/m${pad(f)}.test.ts`;
    const bad = failing.get(f);
    if (bad === undefined) {
      out.push(` ✓ ${file} (10 tests) 2ms`);
      continue;
    }
    out.push(` ❯ ${file} (10 tests | 1 failed) 6ms`);
    for (let t = 1; t <= 10; t++) {
      if (t !== bad) out.push(`   ✓ module ${pad(f)} > case ${t} 0ms`);
      else
        out.push(
          `   × module ${pad(f)} > case ${t} 4ms`,
          `     → expected ${t} to be ${t + 1} // Object.is equality`,
        );
    }
  }
  out.push('', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯', '');
  let n = 0;
  for (const [f, t] of failing) {
    n += 1;
    const file = `src/m${pad(f)}.test.ts`;
    // Each case sits on line case + 1, under the describe.
    const frame = [t - 2, t - 1, t, t + 1, t + 2].filter((k) => k >= 1 && k <= 10);
    out.push(
      ` FAIL  ${file} > module ${pad(f)} > case ${t}`,
      `AssertionError: expected ${t} to be ${t + 1} // Object.is equality`,
      '',
      `${ESC}[32m- Expected${ESC}[39m`,
      `${ESC}[31m+ Received${ESC}[39m`,
      '',
      `${ESC}[32m- ${t + 1}${ESC}[39m`,
      `${ESC}[31m+ ${t}${ESC}[39m`,
      '',
      ` ❯ ${file}:${t + 1}:34`,
      ...frame.flatMap((k) => {
        const line = `${String(k + 1).padStart(7)}|${caseLine(k, k === t ? ' + 1' : '')}`;
        return k === t ? [line, `       |${' '.repeat(34)}^`] : [line];
      }),
      '',
      `${RULE}[${n}/8]⎯`,
      '',
    );
  }
  out.push(
    '',
    ' Test Files  8 failed | 22 passed (30)',
    '      Tests  8 failed | 292 passed (300)',
    '   Start at  08:40:26',
    '   Duration  1.39s (transform 282ms, setup 0ms, collect 481ms, tests 178ms, environment 3ms, prepare 2.49s)',
    '',
  );
  return out.join('\n');
}

describe('vitest', () => {
  const report = testReportOf({
    type: 'shell',
    stdout: VITEST_STDOUT,
    stderr: VITEST_STDERR,
    interrupted: false,
    truncated: false,
  }) as TestReport;

  it('totals the run from its summary, files beside tests', () => {
    expect(report.runner).toBe('vitest');
    expect(report.totals).toEqual({
      passed: 3,
      failed: 2,
      skipped: 2,
      total: 7,
      durationMs: 417,
      files: { passed: 0, failed: 3, total: 3 },
    });
    expect(report.cut).toBe(false);
  });

  it('lists each failed test once, with its whole error and the line it failed on', () => {
    expect(report.failures).toEqual([
      {
        name: 'cart > applies a discount code',
        message: 'AssertionError: expected 90 to be 80 // Object.is equality',
        location: { file: 'src/cart.test.ts', line: 6, column: 19 },
      },
      {
        name: 'payment > retries a declined card',
        message: 'AssertionError: expected { attempts: 1 } to deeply equal { attempts: 2 }',
        location: { file: 'src/payment.test.ts', line: 4, column: 29 },
      },
    ]);
  });

  it('counts a file that did not load among the files and never as a test', () => {
    expect(report.failures.map((f) => f.name)).not.toContain('src/broken.test.ts');
    expect(report.totals.files?.failed).toBe(3);
  });

  it('keeps the cases each file listed', () => {
    expect(report.suites?.map((s) => [s.name, s.cases.length])).toEqual([
      ['src/cart.test.ts', 5],
      ['src/payment.test.ts', 2],
    ]);
    const cart = report.suites?.[0].cases ?? [];
    expect(cart.map((c) => c.status)).toEqual(['passed', 'passed', 'failed', 'skipped', 'skipped']);
    expect(cart[2]).toEqual({
      name: 'cart > applies a discount code',
      status: 'failed',
      durationMs: 4,
      message: 'expected 90 to be 80 // Object.is equality',
    });
    expect(cart[3]).toEqual({ name: 'cart > ships abroad', status: 'skipped' });
  });

  it('reads a 300-test run whose head was cut: exact totals, the failures still visible, cut', () => {
    const log = vitest300();
    // The fold keeps the last 2000 characters: every case line is gone, and
    // the first failure's header with them.
    const kept = log.slice(-2000);
    expect(log.length).toBeGreaterThan(kept.length * 3);
    expect(kept).not.toContain('   ✓ module');
    expect(kept).not.toContain('FAIL  src/m03.test.ts');
    const tail = parseTestReport(kept, { truncated: true }) as TestReport;
    expect(tail.totals).toEqual({
      passed: 292,
      failed: 8,
      skipped: 0,
      total: 300,
      durationMs: 1390,
      files: { passed: 22, failed: 8, total: 30 },
    });
    expect(tail.failures.length).toBeGreaterThan(0);
    expect(tail.failures.length).toBeLessThan(8);
    expect(tail.cut).toBe(true);
    expect(tail.failures.at(-1)).toEqual({
      name: 'module 30 > case 10',
      message: 'AssertionError: expected 10 to be 11 // Object.is equality',
      location: { file: 'src/m30.test.ts', line: 11, column: 34 },
    });
    // The case lines were cut away, so no case is claimed.
    expect(tail.suites).toBeUndefined();
  });

  it('reads the whole 300-test run with every failure and no cut', () => {
    const whole = parseTestReport(vitest300()) as TestReport;
    const names = [...FAILING].map(([f, t]) => `module ${pad(f)} > case ${t}`);
    expect(whole.failures.map((f) => f.name).sort()).toEqual(names.sort());
    // First seen in the case lines, which list files as they finished.
    expect(whole.failures[0].name).toBe('module 18 > case 9');
    expect(whole.cut).toBe(false);
    expect(whole.suites).toHaveLength(FAILING.size);
  });

  it('reads the verbose reporter and an unhandled error', () => {
    const verbose = parseTestReport(`
 ✓ src/payment.test.ts > payment > charges the saved card 1ms
 × src/payment.test.ts > payment > retries a declined card 5ms
   → expected { attempts: 1 } to deeply equal { attempts: 2 }
 ↓ src/cart.test.ts > cart > ships abroad

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 1 passed | 1 skipped (3)
     Errors  1 error
   Start at  08:40:51
   Duration  1.2s (transform 33ms, setup 0ms)
`) as TestReport;
    expect(verbose.totals).toMatchObject({ failed: 1, total: 3, errors: 1, durationMs: 1200 });
    expect(verbose.failures).toEqual([
      {
        name: 'payment > retries a declined card',
        message: 'expected { attempts: 1 } to deeply equal { attempts: 2 }',
        location: { file: 'src/payment.test.ts' },
      },
    ]);
    expect(verbose.suites?.map((s) => s.name)).toEqual(['src/payment.test.ts', 'src/cart.test.ts']);
  });

  it('gives an error vitest printed once to every test that failed with it', () => {
    const grouped = parseTestReport(`
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/db.test.ts > db > reads
 FAIL  src/db.test.ts > db > writes
Error: connect ECONNREFUSED 127.0.0.1:5432
 ❯ connect src/db.ts:12:11
 ❯ src/db.test.ts:4:5

${RULE}[1/1]⎯

 Test Files  1 failed (1)
      Tests  2 failed (2)
`) as TestReport;
    expect(grouped.failures).toEqual(
      ['db > reads', 'db > writes'].map((name) => ({
        name,
        message: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
        location: { file: 'src/db.test.ts', line: 4, column: 5 },
      })),
    );
    expect(grouped.cut).toBe(false);
  });
});

/** A jest 29 run with --verbose: four files, one of which does not run. */
const JEST = `
 PASS  src/format.test.js
  ✓ formats a price (1 ms)
  ✓ rounds half up

 FAIL  src/cart.test.js
  cart
    ✓ adds an item (2 ms)
    ✕ applies a discount code (4 ms)
    ○ skipped ships abroad
    ✎ todo handles gift cards

  ● cart › applies a discount code

    expect(received).toBe(expected) // Object.is equality

    Expected: 80
    Received: 90

       5 |   test('applies a discount code', () => {
       6 |     const total = 90;
    >  7 |     expect(total).toBe(80);
         |                   ^
       8 |   });

      at Object.toBe (src/cart.test.js:7:19)

 FAIL  src/broken.test.js
  ● Test suite failed to run

    Cannot find module './nowhere' from 'src/broken.test.js'

      at Resolver._throwModNotFoundError (node_modules/jest-resolve/build/resolver.js:427:11)

 PASS  src/log.test.js
  ● Console

    console.log
      hello

      at Object.log (src/log.test.js:2:11)

Test Suites: 2 failed, 2 passed, 4 total
Tests:       1 failed, 1 skipped, 1 todo, 4 passed, 7 total
Snapshots:   0 total
Time:        1.234 s, estimated 2 s
Ran all test suites.
`;

describe('jest', () => {
  it('totals the run and reads its failure blocks, never Console or a suite that did not run', () => {
    const report = parseTestReport(JEST) as TestReport;
    expect(report.runner).toBe('jest');
    expect(report.totals).toEqual({
      passed: 4,
      failed: 1,
      skipped: 2,
      total: 7,
      durationMs: 1234,
      files: { passed: 2, failed: 2, total: 4 },
    });
    expect(report.failures).toEqual([
      {
        name: 'cart › applies a discount code',
        message: 'expect(received).toBe(expected) // Object.is equality',
        location: { file: 'src/cart.test.js', line: 7, column: 19 },
      },
    ]);
    expect(report.cut).toBe(false);
    expect(report.suites).toEqual([
      {
        name: 'src/format.test.js',
        cases: [
          { name: 'formats a price', status: 'passed', durationMs: 1 },
          { name: 'rounds half up', status: 'passed' },
        ],
      },
      {
        name: 'src/cart.test.js',
        cases: [
          { name: 'adds an item', status: 'passed', durationMs: 2 },
          { name: 'applies a discount code', status: 'failed', durationMs: 4 },
          { name: 'ships abroad', status: 'skipped' },
          { name: 'handles gift cards', status: 'skipped' },
        ],
      },
    ]);
  });

  it('lists a failure its summary of failing tests repeats only once', () => {
    const summary = JEST.replace(
      'Test Suites:',
      `Summary of all failing tests
 FAIL  src/cart.test.js
  ● cart › applies a discount code

    expect(received).toBe(expected) // Object.is equality

Test Suites:`,
    );
    expect((parseTestReport(summary) as TestReport).failures).toHaveLength(1);
  });

  it('reads an older jest time without the space', () => {
    const report = parseTestReport('Tests:       3 passed, 3 total\nTime:        2.5s\n');
    expect(report?.totals).toEqual({
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
      durationMs: 2500,
    });
  });
});

/** `cargo test --no-fail-fast`: unit tests, an integration test, a doc test. */
const CARGO_STDOUT = `
running 6 tests
test tests::disk ... ignored, needs a disk
test tests::slow ... ignored
test tests::adds_two ... ok
test tests::nested::deep ... ok
test tests::adds_three ... FAILED
test tests::picks_out_of_range ... FAILED

failures:

---- tests::adds_three stdout ----

thread 'tests::adds_three' (55407859) panicked at src/lib.rs:16:23:
assertion \`left == right\` failed
  left: 3
 right: 4
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

---- tests::picks_out_of_range stdout ----

thread 'tests::picks_out_of_range' (55407862) panicked at src/lib.rs:8:43:
index out of bounds: the len is 3 but the index is 10


failures:
    tests::adds_three
    tests::picks_out_of_range

test result: FAILED. 2 passed; 2 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 1 test
test api_works ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 1 test
test src/lib.rs - add (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s
`;

const CARGO_STDERR = `   Compiling toy v0.1.0 (/Users/me/toy)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 1.07s
     Running unittests src/lib.rs (target/debug/deps/toy-e01186f4b80532b8)
error: test failed, to rerun pass \`--lib\`
     Running tests/api.rs (target/debug/deps/api-270360e808f49ff4)
   Doc-tests toy
error: 1 target failed:
    \`--lib\`
`;

describe('cargo test', () => {
  const shell = (truncated: boolean) =>
    testReportOf({
      type: 'shell',
      stdout: CARGO_STDOUT,
      stderr: CARGO_STDERR,
      interrupted: false,
      truncated,
    });

  it("sums every binary's result and reads each panic", () => {
    const report = shell(false) as TestReport;
    expect(report.runner).toBe('cargo');
    expect(report.totals).toEqual({ passed: 4, failed: 2, skipped: 2, total: 8, durationMs: 200 });
    expect(report.failures).toEqual([
      {
        name: 'tests::adds_three',
        message: 'assertion `left == right` failed',
        location: { file: 'src/lib.rs', line: 16, column: 23 },
      },
      {
        name: 'tests::picks_out_of_range',
        message: 'index out of bounds: the len is 3 but the index is 10',
        location: { file: 'src/lib.rs', line: 8, column: 43 },
      },
    ]);
    expect(report.cut).toBe(false);
    expect(report.suites).toBeUndefined();
  });

  it('totals nothing once the head was cut, since a whole binary may be gone', () => {
    expect(shell(true)).toBeNull();
    expect(parseTestReport(CARGO_STDOUT, { truncated: true })).toBeNull();
  });

  it('totals nothing when a binary started and never reported', () => {
    const crashed = `running 2 tests
test a ... ok
test b ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s


running 3 tests
test c ... ok
error: test failed, to rerun pass \`--test api\`

Caused by:
  process didn't exit successfully: \`/x/target/debug/deps/api-1\` (signal: 11, SIGSEGV: invalid memory reference)
`;
    expect(parseTestReport(crashed)).toBeNull();
  });

  it('reads the quoted panic of older Rust', () => {
    const report = parseTestReport(`running 1 test
test parse::rejects ... FAILED

failures:

---- parse::rejects stdout ----
thread 'parse::rejects' panicked at 'expected an error', src/parse.rs:40:9


failures:
    parse::rejects

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
`);
    expect(report?.failures).toEqual([
      {
        name: 'parse::rejects',
        message: 'expected an error',
        location: { file: 'src/parse.rs', line: 40, column: 9 },
      },
    ]);
    expect(report?.totals).toEqual({ passed: 0, failed: 1, skipped: 0, total: 1, durationMs: 0 });
  });
});

/** pytest 8 with its default short summary (`-rfE`). */
const PYTEST = `============================= test session starts ==============================
platform darwin -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0
rootdir: /Users/me/calc
configfile: pyproject.toml
collected 14 items

tests/test_db.py ....E                                                   [ 35%]
tests/test_math.py ..F.s.sx.                                             [100%]

==================================== ERRORS ====================================
_______________________ ERROR at setup of test_connect _________________________

    @pytest.fixture
    def db():
>       raise ConnectionError("refused")
E       ConnectionError: refused

tests/conftest.py:6: ConnectionError
=================================== FAILURES ===================================
___________________________________ test_add ___________________________________

    def test_add():
>       assert add(1, 2) == 4
E       assert 3 == 4
E        +  where 3 = add(1, 2)

tests/test_math.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_add - assert 3 == 4
ERROR tests/test_db.py::test_connect - ConnectionError: refused
============= 1 failed, 9 passed, 2 skipped, 1 xfailed, 1 error in 0.42s =============
`;

describe('pytest', () => {
  it('totals errors as failures and expected failures as skipped', () => {
    const report = parseTestReport(PYTEST) as TestReport;
    expect(report.runner).toBe('pytest');
    expect(report.totals).toEqual({
      passed: 9,
      failed: 2,
      skipped: 3,
      total: 14,
      durationMs: 420,
    });
    expect(report.failures).toEqual([
      {
        name: 'test_add',
        message: 'assert 3 == 4',
        location: { file: 'tests/test_math.py', line: 9 },
      },
      {
        name: 'test_connect',
        message: 'ConnectionError: refused',
        location: { file: 'tests/conftest.py', line: 6 },
      },
    ]);
    expect(report.cut).toBe(false);
    expect(report.suites).toBeUndefined();
  });

  it('keeps the cases -v lists, and reads a long run in quiet mode', () => {
    const verbose =
      parseTestReport(`tests/test_math.py::test_add PASSED                                      [ 33%]
tests/test_math.py::test_sub SKIPPED (no subtraction yet)                [ 66%]
tests/test_math.py::TestCalc::test_div FAILED                            [100%]

=================================== FAILURES ===================================
______________________________ TestCalc.test_div _______________________________

self = <tests.test_math.TestCalc object at 0x104d2f350>

    def test_div(self):
>       assert div(1, 0) == 0

tests/test_math.py:21:
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _

    def div(a, b):
>       return a / b
E       ZeroDivisionError: division by zero

calc/ops.py:3: ZeroDivisionError
=========================== short test summary info ============================
FAILED tests/test_math.py::TestCalc::test_div - ZeroDivisionError: division by zero
==================== 1 failed, 1 passed, 1 skipped in 0.05s ====================
`) as TestReport;
    expect(verbose.suites).toEqual([
      {
        name: 'tests/test_math.py',
        cases: [
          { name: 'test_add', status: 'passed' },
          { name: 'test_sub', status: 'skipped' },
          { name: 'TestCalc::test_div', status: 'failed' },
        ],
      },
    ]);
    // The traceback runs into calc/ops.py; the test failed on its own line 21.
    expect(verbose.failures).toEqual([
      {
        name: 'TestCalc::test_div',
        message: 'ZeroDivisionError: division by zero',
        location: { file: 'tests/test_math.py', line: 21 },
      },
    ]);
    const quiet = parseTestReport('..F.\n1 failed, 3 passed in 61.03s (0:01:01)\n');
    expect(quiet?.totals).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
      total: 4,
      durationMs: 61030,
    });
    expect(quiet?.cut).toBe(true);
  });

  it('reads "no tests ran" as a run of none', () => {
    expect(parseTestReport('== 2 deselected in 0.01s ==')?.totals.total).toBe(0);
    expect(parseTestReport('===== no tests ran in 0.01s =====')?.totals).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      durationMs: 10,
    });
  });

  it('lists a test that failed and then errored in teardown twice, as pytest counts it', () => {
    const report =
      parseTestReport(`=========================== short test summary info ============================
FAILED tests/test_db.py::test_write - assert 0 == 1
ERROR tests/test_db.py::test_write - OSError: close failed
==================== 1 failed, 4 passed, 1 error in 0.30s ======================
`) as TestReport;
    expect(report.totals).toMatchObject({ passed: 4, failed: 2, total: 6 });
    expect(report.failures.map((f) => [f.name, f.message])).toEqual([
      ['test_write', 'assert 0 == 1'],
      ['test_write', 'OSError: close failed'],
    ]);
    expect(report.cut).toBe(false);
  });
});

/** `go test -v ./...`: a package that does not build, one that fails, one that passes. */
const GO_VERBOSE = `FAIL\texample.com/toy/broken [build failed]
=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
    calc_test.go:13: Sub(3, 1) = 4; want 2
--- FAIL: TestSub (0.00s)
=== RUN   TestSkip
    calc_test.go:18: not ready
--- SKIP: TestSkip (0.00s)
=== RUN   TestTable
=== RUN   TestTable/one
=== RUN   TestTable/two
    calc_test.go:23: wrong
--- FAIL: TestTable (0.00s)
    --- PASS: TestTable/one (0.00s)
    --- FAIL: TestTable/two (0.00s)
FAIL
FAIL\texample.com/toy/calc\t0.315s
=== RUN   TestOther
--- PASS: TestOther (0.00s)
PASS
ok  \texample.com/toy/other\t0.170s
FAIL
`;

const GO_STDERR = `# example.com/toy/broken [example.com/toy/broken.test]
broken/broken_test.go:5:33: undefined: undefinedThing
`;

/** The same run without -v: passing tests print nothing. */
const GO_QUIET = `FAIL\texample.com/toy/broken [build failed]
--- FAIL: TestSub (0.00s)
    calc_test.go:13: Sub(3, 1) = 4; want 2
--- FAIL: TestTable (0.00s)
    --- FAIL: TestTable/two (0.00s)
        calc_test.go:23: wrong
FAIL
FAIL\texample.com/toy/calc\t0.149s
ok  \texample.com/toy/other\t0.286s
FAIL
`;

describe('go test', () => {
  it('totals a -v run from its result lines, and counts a package that failed outside its tests', () => {
    const report = testReportOf({
      type: 'shell',
      stdout: GO_VERBOSE,
      stderr: GO_STDERR,
      interrupted: false,
      truncated: false,
    }) as TestReport;
    expect(report.runner).toBe('go');
    expect(report.totals).toEqual({ passed: 2, failed: 2, skipped: 1, total: 5, errors: 1 });
    expect(report.failures).toEqual([
      {
        name: 'TestSub',
        message: 'Sub(3, 1) = 4; want 2',
        location: { file: 'calc_test.go', line: 13 },
      },
      { name: 'TestTable', message: 'wrong', location: { file: 'calc_test.go', line: 23 } },
    ]);
    expect(report.suites?.map((s) => [s.name, s.cases.map((c) => c.status)])).toEqual([
      ['example.com/toy/calc', ['passed', 'failed', 'skipped', 'failed']],
      ['example.com/toy/other', ['passed']],
    ]);
    expect(report.suites?.[0].cases[0]).toEqual({
      name: 'TestAdd',
      status: 'passed',
      durationMs: 0,
    });
  });

  it('totals nothing without -v, or once the head was cut', () => {
    expect(parseTestReport(GO_QUIET)).toBeNull();
    expect(parseTestReport(GO_VERBOSE, { truncated: true })).toBeNull();
  });

  it('counts a package that timed out as an error, not as passing', () => {
    const report = parseTestReport(`=== RUN   TestQuick
--- PASS: TestQuick (0.00s)
=== RUN   TestSlow
panic: test timed out after 1s
\trunning tests:
\t\tTestSlow (1s)

goroutine 7 [running]:
testing.(*M).startAlarm.func1()
\t/usr/local/go/src/testing/testing.go:2484 +0x320
FAIL\texample.com/toy/slow\t1.012s
FAIL
`);
    expect(report?.totals).toEqual({ passed: 1, failed: 0, skipped: 0, total: 1, errors: 1 });
  });
});

/** `playwright test` with the list reporter, two projects and one retry. */
const PLAYWRIGHT = `
Running 8 tests using 2 workers

  ✓  1 [webkit] › tests/home.spec.js:4:3 › home › has title (3ms)
  ✓  2 [chromium] › tests/home.spec.js:4:3 › home › has title (3ms)
  ✘  3 [webkit] › tests/home.spec.js:5:3 › home › opens docs (2ms)
  ✘  4 [chromium] › tests/home.spec.js:5:3 › home › opens docs (2ms)
  ✘  5 [webkit] › tests/home.spec.js:5:3 › home › opens docs (retry #1) (5ms)
  ✘  6 [chromium] › tests/home.spec.js:5:3 › home › opens docs (retry #1) (5ms)
  -  7 [webkit] › tests/home.spec.js:6:8 › home › later
  -  9 [chromium] › tests/home.spec.js:6:8 › home › later
  ✘  8 [webkit] › tests/home.spec.js:7:3 › home › flaky one (4ms)
  ✘  10 [chromium] › tests/home.spec.js:7:3 › home › flaky one (4ms)
  ✓  12 [webkit] › tests/home.spec.js:7:3 › home › flaky one (retry #1) (3ms)
  ✓  11 [chromium] › tests/home.spec.js:7:3 › home › flaky one (retry #1) (3ms)


  1) [chromium] › tests/home.spec.js:5:3 › home › opens docs ───────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "Getting started"
    Received: "Installation"

    > 5 |   test('opens docs', async () => { expect('Installation').toBe('Getting started'); });
        |                                                           ^
        at /Users/me/site/tests/home.spec.js:5:59

    Error Context: test-results/home-home-opens-docs-chromium/error-context.md

    Retry #1 ───────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

  2) [webkit] › tests/home.spec.js:5:3 › home › opens docs ─────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Error Context: test-results/home-home-opens-docs-webkit/error-context.md

  2 failed
    [chromium] › tests/home.spec.js:5:3 › home › opens docs ────────────────────
    [webkit] › tests/home.spec.js:5:3 › home › opens docs ──────────────────────
  2 flaky
    [chromium] › tests/home.spec.js:7:3 › home › flaky one ─────────────────────
    [webkit] › tests/home.spec.js:7:3 › home › flaky one ───────────────────────
  2 skipped
  2 passed (1.5s)

  To open last HTML report run:

    npx playwright show-report
`;

describe('playwright', () => {
  const report = parseTestReport(PLAYWRIGHT) as TestReport;

  it('totals a flaky test as passed, and lists the failures its summary names', () => {
    expect(report.runner).toBe('playwright');
    expect(report.totals).toEqual({ passed: 4, failed: 2, skipped: 2, total: 8, durationMs: 1500 });
    expect(report.failures).toEqual([
      {
        name: '[chromium] › home › opens docs',
        message: 'Error: expect(received).toBe(expected) // Object.is equality',
        location: { file: 'tests/home.spec.js', line: 5, column: 3 },
      },
      {
        name: '[webkit] › home › opens docs',
        message: 'Error: expect(received).toBe(expected) // Object.is equality',
        location: { file: 'tests/home.spec.js', line: 5, column: 3 },
      },
    ]);
    expect(report.cut).toBe(false);
  });

  it("keeps each test's last attempt", () => {
    const cases = report.suites?.[0].cases ?? [];
    expect(report.suites?.map((s) => s.name)).toEqual(['tests/home.spec.js']);
    expect(cases).toHaveLength(8);
    expect(cases.find((c) => c.name === '[webkit] › home › flaky one')).toEqual({
      name: '[webkit] › home › flaky one',
      status: 'passed',
      durationMs: 3,
    });
    expect(cases.find((c) => c.name === '[chromium] › home › later')).toEqual({
      name: '[chromium] › home › later',
      status: 'skipped',
    });
  });

  it('reads a passing run and a duration in minutes', () => {
    const passing = parseTestReport('Running 40 tests using 4 workers\n\n  40 passed (1m 15.3s)\n');
    expect(passing?.totals).toEqual({
      passed: 40,
      failed: 0,
      skipped: 0,
      total: 40,
      durationMs: 75300,
    });
  });

  it('totals nothing when the cut fell inside its summary', () => {
    const summary = PLAYWRIGHT.slice(PLAYWRIGHT.indexOf('  2 failed'));
    const inside = summary.slice(summary.indexOf('\n') + 1);
    expect(parseTestReport(inside, { truncated: true })).toBeNull();
    const fromFlaky = summary.slice(summary.indexOf('  2 flaky'));
    expect(parseTestReport(`x\n${fromFlaky}`, { truncated: true })).toBeNull();
    // Failed prints first: a cut just above it lost nothing of the summary.
    expect(parseTestReport(`x\n${summary}`, { truncated: true })?.totals.failed).toBe(2);
  });

  it('counts errors outside any test', () => {
    const fatal = parseTestReport(
      'Running 3 tests using 1 worker\n\n  3 passed (2.0s)\n  1 error was not a part of any test, see above for details\n',
    );
    expect(fatal?.totals).toEqual({
      passed: 3,
      failed: 0,
      skipped: 0,
      total: 3,
      durationMs: 2000,
      errors: 1,
    });
  });
});

describe('output with no final summary', () => {
  it.each([
    ['a missing script', ' ERR_PNPM_NO_SCRIPT  Missing script: test'],
    ['a compile error', 'error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:3:5'],
    ['failures whose summary never printed', VITEST_STDERR],
    ['a lone count that is not Playwright', 'Retried:\n  2 passed\n'],
    ['a timing line in words pytest never counts in', 'Formatting...\n3 files in 0.2s\n'],
    ['nothing', ''],
  ])('is no report: %s', (_label, output) => {
    expect(parseTestReport(output)).toBeNull();
  });
});

describe('a cut shell result', () => {
  it('reads a short stream whole beside the one the fold cut', () => {
    const report = testReportOf({
      type: 'shell',
      stdout: 'x'.repeat(2000),
      stderr: 'Tests:       1 failed, 2 passed, 3 total\nTime:        1.2 s\n',
      interrupted: false,
      truncated: true,
    });
    expect(report?.runner).toBe('jest');
    expect(report?.totals).toEqual({
      passed: 2,
      failed: 1,
      skipped: 0,
      total: 3,
      durationMs: 1200,
    });
    // The failure itself was cut away, so the view says it shows 0 of 1.
    expect(report?.cut).toBe(true);
  });
});

describe('several runs in one output', () => {
  it('reports the run whose summary printed last', () => {
    const both = `${VITEST_STDOUT}\n${PYTEST}`;
    expect(parseTestReport(both)?.runner).toBe('pytest');
    expect(parseTestReport(`${PYTEST}\n${VITEST_STDOUT}`)?.runner).toBe('vitest');
  });
});

describe('terminal text', () => {
  it('reads through colour codes, CRLF and carriage-return rewrites', () => {
    const report = parseTestReport(
      `Running 2 tests\r\n  ${ESC}[32m2 passed${ESC}[39m${ESC}[2m (2.1s)${ESC}[22m\r\n`,
    );
    expect(report?.totals).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      total: 2,
      durationMs: 2100,
    });
    const pytest = parseTestReport(
      'collecting ...\rcollected 2 items\n== 2 passed in 0.10s ==\r\n',
    );
    expect(pytest?.totals.passed).toBe(2);
  });
});
