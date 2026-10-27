# M96 — Native connector credential platform decision

**Status:** Accepted by the owner on 2026-10-23: “Use macOS Keychain (Recommended)”. Rust-only macOS adapter/dependency implementation is authorized. No actual account credential has been read or imported by this decision.

[Implementation plan, M96.2](../plans/2026-10-23-m96-connectors-mcp-and-actions.md#m962--account-lifecycle-credential-broker-and-explicit-legacy-migration) · [ACT design](2026-10-23-m96-connectors-mcp-and-actions-design.md#credential-bootstrap-and-broker-admission).

The plan requires: “Add an OS secret-store dependency only after owner/platform selection.” The proposed first supported platform is macOS, matching the current packaged application and acceptance environment. The recommended store is **macOS Keychain through a Rust-only Security framework adapter**. Other operating systems return an explicit unsupported state until their adapters and packaged tests exist.

## Concrete proposal

- Use the native Keychain generic-password APIs through a target-specific Rust dependency. The reviewed candidate is `security-framework` 3.7.0; pin the resolved dependency and lockfile after selection and verify its minimum OS/toolchain compatibility before integration. Its documented generic-password operations support create/update, read and delete. [Crate API](https://docs.rs/security-framework/3.7.0/security_framework/passwords/index.html).
- Store only app-owned connector secrets under a Cerebro service namespace and an opaque per-installation secret reference. Account subject, issuer, granted-scope digest, connection revision and secret revision remain distinct safe metadata. A reference is never treated as proof that a secret can currently be read.
- Acquire the proposed GitHub beta credential only after the person's Connect/Replace action for an explicitly selected `github.com` login, using the plan's bounded native `gh` process and authenticated identity check. Do not read the user's Keychain broadly, change `gh`'s active account or modify its credential store.
- Keep credential bytes in the native acquisition/provider adapters. React, IPC DTOs, runtime metadata, diagnostics, exports and crash/report fixtures receive no token values. Use native framework calls rather than passing a secret to a shell utility.
- Install a new secret revision before a checked account-binding commit; an obsolete/cancelled attempt deletes only its unused app-owned item. Disconnect durably disables the binding first. Failed secret deletion remains visible/retryable and never enables dispatch again.
- Treat missing items, locked/denied Keychain access and unavailable services as explicit repair states. Do not silently fall back to a plaintext file or invent a successful connection. No automatic `gh` re-import or token refresh is introduced by this beta.

Apple describes Keychain Services as its API for storing passwords and other secret material. The adapter still requires application-level issuer/account binding, revision checks and redaction; Keychain alone does not establish those contracts. [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services).

## Reviewable alternatives

| Selection | Immediate implementation | Tradeoff |
| --- | --- | --- |
| macOS Keychain (recommended) | Native Rust adapter plus current macOS packaged acceptance | Delivers the current desktop platform; other operating systems remain explicitly unsupported |
| Defer the native store | Finish account lifecycle and migration tests against disposable fake stores only | No managed credential installation or usable managed-provider beta until a store is selected |

A cross-platform abstraction can later add native adapters without changing AccountBinding or exposing secrets to the frontend. This decision does not approve a native-UI rewrite, external service mutation or production credential import.

## Acceptance after selection

Run the existing M96.2 cancellation, stale completion, identity mismatch, reconnect/revoke and sentinel-secret tests through fake bounded process/secret seams. Then verify a packaged macOS build against an explicitly disposable app-owned Keychain item: create, read, replace and delete, denied/unavailable access where reproducible, plus cleanup after cancellation. Record package identity, OS version and limitations. Real account import and provider-effect acceptance remain separate explicit product actions.

## Owner decision

2026-10-23: the owner selected **“Use macOS Keychain (Recommended)”** in response to the concrete platform question. Proceed with the Rust-only macOS Keychain adapter and its targeted dependency after the documented compatibility review. Other operating systems remain explicitly unsupported initially. Real account import still requires the person’s specific Connect/Replace action; no credential import or provider mutation follows merely from choosing the platform.

## Initial GitHub credential evidence limitation

The first native import supports only credentials whose authenticated `X-OAuth-Scopes` evidence lists names from `shared/policy/github-import.v1.json`: `gist`, `read:org`, `repo` and `workflow`. Other classic scope names, absent or empty scope evidence, fine-grained personal access tokens and GitHub App tokens return Unsupported. This is a beta limitation, not a claim to support every classic credential. A scope digest records provider evidence and grants no local action capability.
