# Cerebro

Files-first work management. Projects, docs, and work items live in a folder of
markdown files you own — open the same folder in any editor and it is all still
there. The assistant is the [Claude Code CLI](https://claude.com/claude-code)
already installed on your machine, so no API key ever goes into the app.

## Run it on a Mac

### Download a build

Every push builds a Mac app. Open the repository's **Actions** tab, pick the
most recent **Mac app** run for your branch, and download the `Cerebro-macOS`
artifact. Unzip it, open `Cerebro.dmg`, and drag Cerebro to Applications. (The
artifact also holds `Cerebro.zip` — the same app, if you would rather unzip it
than mount a disk image.)

Then clear the quarantine flag once:

```sh
xattr -dr com.apple.quarantine /Applications/Cerebro.app
```

macOS sets that flag on anything downloaded from the internet and refuses to
open it unless the app is notarized by a paid Apple Developer account. The
command removes the flag; it is not a workaround for a broken app, it is the
normal cost of a build that is not notarized. Without it you get "Cerebro is
damaged and can't be opened", which is macOS being unhelpfully worded about
exactly this.

The download is a universal binary — the same app runs on Apple Silicon and
Intel.

### Or build it yourself

```sh
git clone https://github.com/jlagorio/cerebro.git
cd cerebro
./scripts/mac-build.sh
```

That checks the toolchain, builds for your Mac's own architecture, signs the
app, installs it to `/Applications`, and opens it. The first run compiles the
Rust side and takes a while; later runs are much faster. Pass `--no-install` to
build without touching `/Applications`, or `--universal` to build something
that runs on both Apple Silicon and Intel.

You need Xcode command line tools (`xcode-select --install`),
[Rust](https://rustup.rs), and Node 20+ with pnpm (`corepack enable`). The
script names anything that is missing instead of failing partway through.

## First run

Choose **Open demo vault** and the app copies a worked example — projects,
docs, typed databases, saved views — into `~/Documents/Cerebro Demo Vault` and
opens it. It is a normal folder of markdown files; edit it, delete it, or point
the app at your own folder with **Choose folder…** instead. macOS may ask for
permission to use your Documents folder the first time; declining is fine, the
demo lands in the app's own data directory instead.

## The assistant

`Cmd+J` opens the assistant panel. It runs the `claude` binary on your machine
as a subprocess, pointed at the open vault, and talks to the app through a
loopback MCP endpoint on `127.0.0.1`. Your conversation goes to Anthropic
through the CLI you already installed and signed into, and nowhere else.

If the panel says Claude Code was not found, install it from
<https://claude.com/claude-code> and reopen the app. The app looks for it on
`PATH`, then through your login shell, then in the places Homebrew, npm, bun,
nvm, Volta, and the native installer put it.

By default the agent may only use Cerebro's own vault tools, which enforce
their own boundaries — `knowledge/` is the assistant's to write and yours to
verify. Settings can widen that to a shell and to your other MCP servers; both
are off unless you turn them on.

## Develop

```sh
pnpm install
pnpm dev:app      # the real app against a real folder, hot reload
pnpm dev          # the UI in a browser against a mock vault — demo mode
pnpm vitest run   # frontend tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
pnpm e2e          # Playwright
```

### The two dev modes

They look identical on screen, so it is worth knowing which one you are in.

`pnpm dev:app` is the app. It opens whatever folder you point it at, writes
your edits to those files, and the assistant panel runs the `claude` binary on
your machine. Use it to find out whether something actually works. Frontend
edits hot-reload; Rust edits rebuild and relaunch. The first run compiles the
Rust side and takes a while. It checks for Rust, Node, pnpm, and your platform's
system libraries up front and names anything missing.

`pnpm dev` is **demo mode**: the vault is a `Map` in memory seeded from
`demo-vault/`, the folder picker returns that same fake path whatever you
choose, and the assistant replies from a fixed script. Nothing survives a
reload and nothing touches disk. It needs no Rust toolchain and is the right
mode for most UI work. The app says so — a "Demo mode" badge sits next to the
wordmark, and the vault chooser explains why **Choose folder…** looks broken.

Both are one predicate, `inTauri()` in `src/lib/runtime.ts`: Tauri injects
`__TAURI_INTERNALS__` into the webview, and its absence means the mocks in
`lib/mockIpc.ts` and `agent/mockAgent.ts` are answering.

To point the real app at your own notes: `pnpm dev:app`, then **Choose
folder…**. The choice is remembered, so later runs reopen it. A vault is just a
folder of markdown — pointing Cerebro at an existing one reads it in place and
adds nothing until you edit something.

On Linux the Rust side additionally needs `libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `libayatana-appindicator3-dev`, and `librsvg2-dev`.

## Shipping a release

Push a tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

That publishes a GitHub release with the DMG attached.

To produce a build that opens without the `xattr` step, you need an Apple
Developer account. Set `MAC_SIGN_IDENTITY` to a Developer ID Application
identity before running `scripts/mac-package.sh`, then notarize the DMG with
`xcrun notarytool submit`.
