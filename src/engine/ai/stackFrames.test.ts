import { describe, expect, it } from 'vitest';
import { originOf, parseStackTrace, type StackTrace } from './stackFrames';

/** Traces as Node 26, Rust 1.95, Python 3.13 and Go 1.25 printed them on
 * 2026-10-22 (home paths shortened), and as Firefox prints its own. */

describe('V8 (Node and Chromium)', () => {
  it('splits the message from its frames and says what each file names', () => {
    const trace = parseStackTrace(`> shop@1.0.0 seed
> tsx prisma/seed.ts

TypeError: Cannot read properties of undefined (reading 'email')
    at seedUsers (prisma/seed.ts:27:34)
    at main (./prisma/seed.ts:51:9)
    at Array.map (<anonymous>)
    at Module._compile (node:internal/modules/cjs/loader:1873:14)
    at Object.transformer (/Users/me/shop/node_modules/tsx/dist/register.cjs:3:1104)
    at async Promise.all (index 0)
    at new Seeder (file:///Users/me/shop/prisma/seeder.mjs:2:3)
    at http://localhost:5173/src/app.ts:10:5

Node.js v26.3.1
`) as StackTrace;
    expect(trace.language).toBe('javascript');
    expect(trace.message).toBe("TypeError: Cannot read properties of undefined (reading 'email')");
    expect(trace.frames).toEqual([
      {
        raw: 'at seedUsers (prisma/seed.ts:27:34)',
        fn: 'seedUsers',
        file: 'prisma/seed.ts',
        origin: 'relative',
        line: 27,
        column: 34,
      },
      {
        raw: 'at main (./prisma/seed.ts:51:9)',
        fn: 'main',
        file: 'prisma/seed.ts',
        origin: 'relative',
        line: 51,
        column: 9,
      },
      { raw: 'at Array.map (<anonymous>)', fn: 'Array.map' },
      {
        raw: 'at Module._compile (node:internal/modules/cjs/loader:1873:14)',
        fn: 'Module._compile',
        file: 'node:internal/modules/cjs/loader',
        origin: 'internal',
        line: 1873,
        column: 14,
      },
      {
        raw: 'at Object.transformer (/Users/me/shop/node_modules/tsx/dist/register.cjs:3:1104)',
        fn: 'Object.transformer',
        file: '/Users/me/shop/node_modules/tsx/dist/register.cjs',
        origin: 'absolute',
        line: 3,
        column: 1104,
      },
      { raw: 'at async Promise.all (index 0)', fn: 'async Promise.all' },
      {
        raw: 'at new Seeder (file:///Users/me/shop/prisma/seeder.mjs:2:3)',
        fn: 'new Seeder',
        file: 'file:///Users/me/shop/prisma/seeder.mjs',
        origin: 'url',
        line: 2,
        column: 3,
      },
      {
        raw: 'at http://localhost:5173/src/app.ts:10:5',
        file: 'http://localhost:5173/src/app.ts',
        origin: 'url',
        line: 10,
        column: 5,
      },
    ]);
  });

  it("reads an uncaught error under its source excerpt, and stops at its cause's frames", () => {
    const trace = parseStackTrace(`/Users/me/shop/cause.js:2
try { inner(); } catch (e) { throw new Error("outer boom", { cause: e }); }
                             ^

Error: outer boom
    at Object.<anonymous> (/Users/me/shop/cause.js:2:36)
    at Module._compile (node:internal/modules/cjs/loader:1873:14)
    ... 5 lines matching cause stack trace ...
    at node:internal/main/run_main_module:33:47 {
  [cause]: Error: inner boom
      at inner (/Users/me/shop/cause.js:1:26)
      at Object.<anonymous> (/Users/me/shop/cause.js:2:7)
}

Node.js v26.3.1
`) as StackTrace;
    expect(trace.message).toBe('Error: outer boom');
    expect(trace.frames.map((f) => f.raw)).toEqual([
      'at Object.<anonymous> (/Users/me/shop/cause.js:2:36)',
      'at Module._compile (node:internal/modules/cjs/loader:1873:14)',
      'at node:internal/main/run_main_module:33:47',
    ]);
    expect(trace.frames[2]).toMatchObject({ file: 'node:internal/main/run_main_module', line: 33 });
  });

  it('keeps a message of several paragraphs whole, from the line that names the error', () => {
    const trace = parseStackTrace(`node:internal/assert/utils:146
  throw error;
  ^

AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

1 !== 2

    at Object.<anonymous> (/Users/me/shop/check.js:2:8)
    at Module._compile (node:internal/modules/cjs/loader:1873:14)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  generatedMessage: true,
  code: 'ERR_ASSERTION',
  operator: 'strictEqual'
}

Node.js v26.3.1
`) as StackTrace;
    expect(trace.message).toBe(
      'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2',
    );
    expect(trace.frames).toHaveLength(4);
    expect(trace.frames[2]).toMatchObject({
      fn: 'Module.executeUserEntryPoint [as runMain]',
      file: 'node:internal/modules/run_main',
      origin: 'internal',
    });
  });

  it('reads a Windows path as absolute', () => {
    const trace = parseStackTrace('Error: x\n    at run (C:\\work\\shop\\seed.js:4:2)\n');
    expect(trace?.frames[0]).toMatchObject({
      fn: 'run',
      file: 'C:\\work\\shop\\seed.js',
      origin: 'absolute',
      line: 4,
    });
  });
});

describe('Firefox and Safari', () => {
  it('reads fn@url frames, and a stack with no message', () => {
    const trace = parseStackTrace(`seedUsers@http://localhost:5173/src/seed.ts:27:34
@http://localhost:5173/src/index.ts:3:1
forEach@[native code]
`) as StackTrace;
    expect(trace.message).toBe('');
    expect(trace.frames).toEqual([
      {
        raw: 'seedUsers@http://localhost:5173/src/seed.ts:27:34',
        fn: 'seedUsers',
        file: 'http://localhost:5173/src/seed.ts',
        origin: 'url',
        line: 27,
        column: 34,
      },
      {
        raw: '@http://localhost:5173/src/index.ts:3:1',
        file: 'http://localhost:5173/src/index.ts',
        origin: 'url',
        line: 3,
        column: 1,
      },
      { raw: 'forEach@[native code]', fn: 'forEach' },
    ]);
  });
});

describe('Rust', () => {
  it('reads a panic with no backtrace as its message and the one place it printed', () => {
    const trace =
      parseStackTrace(`thread 'tests::adds_three' (55407859) panicked at src/lib.rs:16:23:
assertion \`left == right\` failed
  left: 3
 right: 4
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
`) as StackTrace;
    expect(trace.language).toBe('rust');
    expect(trace.message).toBe('assertion `left == right` failed\n  left: 3\n right: 4');
    expect(trace.frames).toEqual([
      {
        raw: "thread 'tests::adds_three' (55407859) panicked at src/lib.rs:16:23:",
        file: 'src/lib.rs',
        origin: 'relative',
        line: 16,
        column: 23,
      },
    ]);
  });

  it('reads a backtrace frame by frame, with the files it printed', () => {
    const trace =
      parseStackTrace(`thread 'tests::picks_out_of_range' (55408702) panicked at src/lib.rs:8:43:
index out of bounds: the len is 3 but the index is 10
stack backtrace:
   0: __rustc::rust_begin_unwind
   1: core::panicking::panic_fmt
   2: core::panicking::panic_bounds_check
   3: toy::pick
             at ./src/lib.rs:8:43
   4: toy::tests::picks_out_of_range
             at ./src/lib.rs:18:31
   5: core::ops::function::FnOnce::call_once
             at /opt/homebrew/Cellar/rust/1.95.0/lib/rustlib/src/rust/library/core/src/ops/function.rs:250:5
note: Some details are omitted, run with \`RUST_BACKTRACE=full\` for a verbose backtrace.
`) as StackTrace;
    expect(trace.message).toBe('index out of bounds: the len is 3 but the index is 10');
    expect(trace.frames).toHaveLength(6);
    expect(trace.frames[0]).toEqual({
      raw: '0: __rustc::rust_begin_unwind',
      fn: '__rustc::rust_begin_unwind',
    });
    expect(trace.frames[3]).toEqual({
      raw: '3: toy::pick\nat ./src/lib.rs:8:43',
      fn: 'toy::pick',
      file: 'src/lib.rs',
      origin: 'relative',
      line: 8,
      column: 43,
    });
    expect(trace.frames[5]).toMatchObject({
      fn: 'core::ops::function::FnOnce::call_once',
      origin: 'absolute',
    });
  });

  it('reads the quoted panic of older Rust', () => {
    const trace = parseStackTrace(
      "thread 'main' panicked at 'called `Option::unwrap()` on a `None` value', src/main.rs:4:37\n",
    );
    expect(trace?.message).toBe('called `Option::unwrap()` on a `None` value');
    expect(trace?.frames).toEqual([
      {
        raw: "thread 'main' panicked at 'called `Option::unwrap()` on a `None` value', src/main.rs:4:37",
        file: 'src/main.rs',
        origin: 'relative',
        line: 4,
        column: 37,
      },
    ]);
  });
});

describe('Python', () => {
  it('reads a traceback innermost first, each frame with its source line', () => {
    const trace = parseStackTrace(`Traceback (most recent call last):
  File "/Users/me/calc/app.py", line 8, in <module>
    main()
    ~~~~^^
  File "/Users/me/calc/app.py", line 6, in main
    return compute(0)
  File "lib/compute.py", line 2, in compute
    return 1 / x
           ~~^~~
  File "<frozen importlib._bootstrap>", line 1360, in _find_and_load
ZeroDivisionError: division by zero
`) as StackTrace;
    expect(trace.language).toBe('python');
    expect(trace.message).toBe('ZeroDivisionError: division by zero');
    expect(trace.frames).toEqual([
      {
        raw: 'File "<frozen importlib._bootstrap>", line 1360, in _find_and_load',
        fn: '_find_and_load',
        file: '<frozen importlib._bootstrap>',
        origin: 'internal',
        line: 1360,
      },
      {
        raw: 'File "lib/compute.py", line 2, in compute\nreturn 1 / x',
        fn: 'compute',
        file: 'lib/compute.py',
        origin: 'relative',
        line: 2,
      },
      {
        raw: 'File "/Users/me/calc/app.py", line 6, in main\nreturn compute(0)',
        fn: 'main',
        file: '/Users/me/calc/app.py',
        origin: 'absolute',
        line: 6,
      },
      {
        raw: 'File "/Users/me/calc/app.py", line 8, in <module>\nmain()',
        fn: '<module>',
        file: '/Users/me/calc/app.py',
        origin: 'absolute',
        line: 8,
      },
    ]);
  });

  it('reads the last traceback of a chained exception', () => {
    const trace = parseStackTrace(`Traceback (most recent call last):
  File "chain.py", line 3, in parse
    return int(s)
ValueError: invalid literal for int() with base 10: 'x'

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "chain.py", line 7, in <module>
    parse("x")
    ~~~~~^^^^^
  File "chain.py", line 5, in parse
    raise RuntimeError("bad input") from e
RuntimeError: bad input
`) as StackTrace;
    expect(trace.message).toBe('RuntimeError: bad input');
    expect(trace.frames.map((f) => [f.fn, f.line])).toEqual([
      ['parse', 5],
      ['<module>', 7],
    ]);
  });
});

describe('Go', () => {
  it("reads a panic and its goroutine's calls", () => {
    const trace = parseStackTrace(`panic: runtime error: index out of range [5] with length 3

goroutine 1 [running]:
main.pick(...)
\t/Users/me/gp/main.go:5
main.(*Store).Load(0x14000012345)
\t/Users/me/gp/store.go:12 +0x1d
main.main()
\t/Users/me/gp/main.go:8 +0x28
exit status 2
`) as StackTrace;
    expect(trace.language).toBe('go');
    expect(trace.message).toBe('runtime error: index out of range [5] with length 3');
    expect(trace.frames).toEqual([
      {
        raw: 'main.pick(...)\n/Users/me/gp/main.go:5',
        fn: 'main.pick',
        file: '/Users/me/gp/main.go',
        origin: 'absolute',
        line: 5,
      },
      {
        raw: 'main.(*Store).Load(0x14000012345)\n/Users/me/gp/store.go:12 +0x1d',
        fn: 'main.(*Store).Load',
        file: '/Users/me/gp/store.go',
        origin: 'absolute',
        line: 12,
      },
      {
        raw: 'main.main()\n/Users/me/gp/main.go:8 +0x28',
        fn: 'main.main',
        file: '/Users/me/gp/main.go',
        origin: 'absolute',
        line: 8,
      },
    ]);
  });
});

describe('anything else', () => {
  it.each([
    ['an error with no frames', "Error: ENOENT: no such file or directory, open 'notes/a.md'"],
    ['a refusal', 'Permission denied: the shell is off for this run.'],
    ['prose that mentions "at"', 'Failed:\n    at least one name is required\n'],
    ['a Go panic with no goroutine', 'panic: boom\n'],
    ['a Python header with no frames', 'Traceback (most recent call last):\nKeyboardInterrupt\n'],
    ['nothing', ''],
  ])('is no trace: %s', (_label, text) => {
    expect(parseStackTrace(text)).toBeNull();
  });

  it('never makes up a frame: one per frame printed', () => {
    const printed = Array.from(
      { length: 12 },
      (_, i) => `    at step${i} (src/steps.ts:${i + 1}:1)`,
    );
    const trace = parseStackTrace(['Error: deep', ...printed, 'after'].join('\n'));
    expect(trace?.frames).toHaveLength(12);
    expect(trace?.frames.map((f) => f.raw)).toEqual(printed.map((line) => line.trim()));
  });

  it('reads through colour codes', () => {
    const trace = parseStackTrace(
      '\u001b[31mError: red\u001b[39m\n    at f (\u001b[36msrc/a.ts:1:2\u001b[39m)\n',
    );
    expect(trace?.message).toBe('Error: red');
    expect(trace?.frames[0]).toMatchObject({ fn: 'f', file: 'src/a.ts', line: 1, column: 2 });
  });
});

describe('origins', () => {
  it.each([
    ['src/a.ts', 'relative'],
    ['../shared/a.ts', 'relative'],
    ['/Users/me/a.ts', 'absolute'],
    ['~/a.ts', 'absolute'],
    ['D:/work/a.ts', 'absolute'],
    ['\\\\server\\share\\a.ts', 'absolute'],
    ['webpack://shop/./src/a.ts', 'url'],
    ['node:fs', 'internal'],
    ['<anonymous>', 'internal'],
  ] as const)('%s is %s', (file, origin) => {
    expect(originOf(file)).toBe(origin);
  });
});
