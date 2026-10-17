# Cerebro

Files-first work management. Projects, docs, and work items live in a folder of
markdown files you own — open the same folder in any editor and it is all still
there. The assistant is the [Claude Code CLI](https://claude.com/claude-code)
already installed on your machine, so no API key ever goes into the app.

## Reminders

Reminders always show in Cerebro. In Settings → Reminders, allow notifications
to also see reminders you set in Notification Center. A self-built app may
need allowing again after it is rebuilt.

## Run it on a Mac

It needs macOS 14 (Sonoma) or later.

### Download a build

Every push to `main` and every `v*` tag builds a Mac app (a tag also publishes
it as a GitHub release). A push to any other branch runs only the checks; to
build that branch, run `gh workflow run mac-app.yml --ref <branch>`. Open the
repository's **Actions** tab, pick the most recent successful **CI & Mac app**
run on `main` (or the run you dispatched), and download the `Cerebro-macOS`
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
[Rust](https://rustup.rs), [Node](https://nodejs.org) and pnpm, at the versions
the repo pins. `rust-toolchain.toml` names the Rust (rustup reads it on its
own); `engines` and `packageManager` in `package.json` name the Node major and
the pnpm release (`npm install -g pnpm@<that release>`). The script names
anything that is missing instead of failing partway through.

## First run

Choose **Open demo vault** and the app copies a worked example — projects,
docs, typed databases, saved views — into `~/Documents/Cerebro Demo Vault` and
opens it. It is a normal folder of markdown files; edit it, delete it, or point
the app at your own folder with **Choose folder…** instead. macOS may ask for
permission to use your Documents folder the first time; declining is fine, the
demo lands in the app's own data directory instead.

**Saving.** A page saves itself as you type. ⌘Q, the close button and ⌘W save
every pending edit first. Dock Quit, logout, restart and shutdown can't be
intercepted, so give a page a moment after the last keystroke before you quit
that way.

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

Cargo stages `demo-vault/` into the ignored `src-tauri/.bundle-resources/`
before Tauri copies resources. This is a sanitized working corpus, including
new ordinary files without requiring Git: runtime/VCS/macOS junk and the
private mail roots declared in `shared/policy/mail.v1.json` are omitted.
Authored hidden content such as `.comments/` and `.gitignore` stays; included
links or special files stop the build. Source bytes are copied unchanged,
and each staging pass replaces its previous snapshot so removed files do
not linger in the shipped demo.

Push a tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

That publishes a GitHub release with the DMG attached.

To produce a build that opens without the `xattr` step, you need an Apple
Developer account. Set `MAC_SIGN_IDENTITY` to a Developer ID Application
identity before running `scripts/mac-package.sh`, then notarize the DMG with
`xcrun notarytool submit`.
