# Packaged macOS verification

This record separates building a native application from operating it successfully. Native
interaction acceptance remains outstanding; the browser evidence does not close these cases.

## Isolation and build

The audit configuration lives outside the repository at
`/private/tmp/cerebro-m90/native/tauri.audit.conf.json`. It gives the bundle the display name
`Cerebro Polish Audit` and identifier `com.cerebro.polish-audit.audit20261017`. Its Info.plist
overrides URL registrations with an empty `CFBundleURLTypes` array, so this test bundle does
not register as the owner's Cerebro link handler. It is built under `src-tauri/target/` and
has not been installed over the owner's application.

The final build completed with Node 26.3.1, pnpm 10.34.7, Rust 1.95.0 and two Cargo jobs.
The existing bundle resources required the repository's local ad-hoc signing step; subsequent
`codesign --verify --deep --strict` succeeded. [Build metadata](native-build.json), the
[build log](native-build.log) and [isolated configuration](native-build-config.json) retain the
exact executable digest and packaging evidence. The
[implementation record](../../plans/2026-10-17-m84-m90-implementation-record.md) records the
overall gate disposition.

## Attempted native interaction

The computer-use tool could discover and launch the audit application. Its first accessibility
response exposed window controls, but subsequent attempts to read or capture the window returned
`cgWindowNotFound`. Repeated lookup by the exact application path, lookup by bundle identifier,
and a fresh tool session produced the same result. The application inventory still reported the
audit process as running. This is a tool/window-access failure, not evidence that native editing
passed or failed.

The first launch's audit configuration unexpectedly named
`/Users/joseflagorio/Documents/Cerebro Demo Vault` as its last vault. No native editing, page
action or acceptance interaction was performed. The exact audit process was stopped, and only
the audit identifier's own configuration was changed to the disposable vault under
`/private/tmp/cerebro-m90/native/vault`. A fresh audit launch confirmed that configured path and
still had no accessible window. Only the verified audit executable was stopped afterward; the
owner's app and its configuration were not modified.

The disposable vault contains three prepared files, no active agents, and no personal-token
listener. No native acceptance is claimed from either launch. The audit application is stopped.

## Case disposition

| Case                                       | Status and required evidence                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final bundle build and signature           | Passed; retained metadata and build log establish packaging only.                                                                                        |
| Native window, menu and focus              | Outstanding: the tool could not obtain an operable window.                                                                                               |
| WKWebView typing, selection and IME        | Outstanding: Chromium/WebKit browser tests and composition unit tests are complementary evidence only.                                                   |
| VoiceOver and nonleading H1                | Outstanding: the first H1 is visually projected while its DOM/source order is preserved; reading order and heading navigation need a native walkthrough. |
| Native clipboard and Finder drop           | Outstanding: no native clipboard or drop interaction was performed.                                                                                      |
| File dialogs, external-open policy and CSP | Outstanding: existing code/contracts were preserved, but this audit did not exercise the packaged OS boundaries.                                         |
| Pending/failed-save quit and close         | Outstanding: no native unsaved-edit/quit scenario was run.                                                                                               |
| AI decision-stage keyboard handling        | Outstanding in the native app; browser writing opens and cancels Ask AI, while existing unit tests cover per-hunk decisions.                             |
| Owner aesthetic acceptance                 | Pending review of the implementation and durable specimens.                                                                                              |

There is no automatic-approval rejection to resolve here. Authorized build and launch operations
ran; the native computer-use surface itself could not be read.
