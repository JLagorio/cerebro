# Cerebro

Files-first work management. Projects, docs, and work items live in a folder of
markdown files you own — open the same folder in any editor and it is all still
there. The assistant is the [Claude Code CLI](https://claude.com/claude-code)
already installed on your machine, so no API key ever goes into the app.

## Run it on a Mac

### Download a build

Every push builds a Mac app. Open the repository's **Actions** tab, pick the
most recent **Mac app** run for your branch, and download the `Cerebro-macOS`
artifact. Unzip it, open `Cerebro.dmg`, and drag Cerebro to Applications.

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

The download is a universal binary — the same DMG runs on Apple Silicon and
Intel.

### Or build it yourself

```sh
git clone https://github.com/jlagorio/cerebro.git
cd cerebro
./scripts/mac-build.sh
```

That checks the toolchain, builds a universal app, signs it, installs it to
`/Applications`, and opens it. The first run compiles the Rust side and takes
several minutes; later runs are much faster. Pass `--no-install` to build
without touching `/Applications`.

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
pnpm dev          # the UI in a browser against an in-memory vault
pnpm tauri dev    # the real app against a real folder
pnpm vitest run   # frontend tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
pnpm e2e          # Playwright
```

`pnpm dev` runs the frontend alone with a mock filesystem seeded from
`demo-vault/`, which is enough for most UI work and needs no Rust toolchain.

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
