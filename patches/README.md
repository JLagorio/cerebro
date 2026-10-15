# IronCalc 0.8.3 package repair

The published `@ironcalc/wasm@0.8.3` tarball imports
`snippets/ironcalc_base-aa721fe913c88060/inline0.js`, but omits that directory
from its package files. The patch adds that file and the missing `snippets`
entry in `package.json`. It changes neither `wasm.js` nor `wasm_bg.wasm`.

The added JavaScript is the exact `inline_js` string from upstream
`ironcalc_base` 0.8.3's `src/tz/browser_tz.rs`, published on crates.io. That
crate's `.cargo_vcs_info.json` and the npm release's `gitHead` both name
`9bed9ec023e645101df6b6ac5aebbe0708b259fb`. It is upstream IronCalc code,
licensed MIT OR Apache-2.0; Cerebro uses it under Apache-2.0. The upstream
project is https://github.com/ironcalc/IronCalc and names Nicolás Hatcher as
the crate author. No code from Macro's fork is used.

`pnpm-workspace.yaml` registers this patch so clean installs apply it.
`scripts/ironcalc.test.ts` limits the patch to those two packaging paths;
`src/lib/mockSheet.ironcalc.test.ts` loads the resulting engine and replays
the same calculation cases as Rust. Remove the repair only when both engine
pins move together to matching upstream releases that include the shim.
