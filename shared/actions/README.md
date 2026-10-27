# Managed action contracts (M96)

Rust owns the contract, bounded validation and retained native broker in
`src-tauri/src/actions/`. Shared kernels take their caller's existing transaction;
the path-based effect service and fixture authority remain test-only. Native
account and this-run grant commands authenticate the actual injected window.
Original attended managed MCP calls additionally require their exact matched
bearer/publication, installed native origin and retained runtime/store checks.
One fixed macOS GitHub worker owns credential resolution, physical request cleanup
and original-fact settlement. Runtime migrations install normally. The contract
is `docs/superpowers/specs/2026-10-23-m96-action-contract.md`, continued by
`docs/superpowers/specs/2026-10-26-m96-github-action-adapter-design.md`.

`cases.v1.json` is shared evidence. Rust replays canonicalization, schema
validation and provider-annotation cases. TypeScript checks generated transport
and fixture evidence, without duplicating native validation/classification.
`shared/policy/actions.v1.json` holds bounds, supported schema keywords/types,
seven effect classes, reserved route/refusal names and default-deny native admission rules. Its SHA-256 anchor is
checked by Rust and TypeScript. The shared tool manifest supplies the five managed
route schemas; the actual loopback caller and retained native owner establish
authority. The action policy declares retained-native-origin registration only;
neither its bounds nor provider annotations grant account or effect access.

`contracts.v1.json` comes from Rust/Schemars. `src/lib/generated/actions.ts` is
projected through the existing shared generator, whose `--check` checks both
workspace and action transports. Internal ActionSubject and person decisions
are deliberately excluded. Raw input/schema JSON text avoids JavaScript parsing
before native exact canonicalization. SafeCounter is the only numeric wire
schema: a bounded nonnegative integer, never an unbounded u64-to-number cast.

Regeneration (repository root, pinned toolchains):

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib actions::tests::export_action_contract_schema -- --ignored --exact
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib actions::tests::write_action_policy_digest -- --ignored --exact
pnpm exec node --import tsx scripts/contracts/generate.ts
```

Checks:

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib actions:: -- --test-threads=2
pnpm test:run src/engine/actions/actionContract.test.ts
pnpm exec vitest run scripts/contracts --maxWorkers=2
pnpm exec node --import tsx scripts/contracts/generate.ts --check
pnpm typecheck
```

Definition export/import rechecks material and derived digests in a fresh catalog.
Future durable storage can retain those immutable bytes; successful in-memory
reconstruction does not establish real invocation restart/recovery acceptance.

`admission-cases.v1.json` pins the shared admission section, literal versioned
scope bytes/digest, exact reviewed V35 SQL digest, forged relationship cases and
parent outcome cases. Rust replays actual disposable SQLite joins and parent
outcomes. Fixture-only proofs do not establish native authentication. Real
MCP bearer, client Ticket and attended window/seat producers and their door tests
remain acceptance gates; a matching actor/person string is never sufficient.
No store identity or native provenance is backfilled into old runs. Owning a
managed connection grants no action. Grant rows used by isolated tests remain explicit fixtures. The actual attended
grant writer derives its original run from the injected native window and live
publication; fixture metadata cannot construct that authority.

Focused native admission checks (coordinated shared native window):

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib actions::native_admission_tests:: -- --nocapture
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib runtime::action_authority::tests:: -- --nocapture
```

The compiled local definition artifact `github-issues.v1.json` names exactly
`github.issue.read` and `github.issue.create`, each requiring its own explicit
capability. It is app-supported schema metadata, not provider discovery or an
observation of an account's remote permissions. Only the guarded original native producer selects the fixed macOS executor.
Other NoExecutor reads and unsupported platforms retain unavailable metadata.
Missing/failing native origin or reads remain typed errors; only an actually read
scope with no eligible grants has an empty catalog.

Both body schemas cap character length at 8,192. The existing shared JSON parser
also caps each encoded JSON string at 8,192 bytes before decoding; Unicode and
escape sequences can reach that byte cap sooner. Schema or parser failures are
explicit, with no truncation. These are local
support bounds, not GitHub server limits. No global parser bound changed.

`action-id-cases.v1.json` declares allowed namespace characters and literal cases.
The compiler accepts lower-case dotted names and valid legacy colon names, such
as `fixture:issue-create` and `Legacy:Original_ID`. Empty segments, non-ASCII,
whitespace/control characters and shell punctuation refuse. This tightens the old
test-gated `contains(':')` predicate; malformed strings were not a compatibility
contract. No frontend namespace validator is introduced.

The real window callback and complete native lifecycle still need a separately
recorded smoke. Disposable SQLite/publication tests do not prove an OS gesture,
provider execution, credential access, grant creation or live remote capability.
The path-based fixture service remains test-only. The real retained dispatcher
and held calls need their separately recorded native acceptance; source/SQL
checks alone do not establish that acceptance.

`github-transport.v1.json` fixes the private issue adapter's protocol mapping,
response and repository bounds, and definitive provider rejection statuses. Its
Rust reader checks the byte digest in `actions/github_issues.rs`; a reviewed policy
edit updates that explicit anchor and replays `actions::github_issues::tests`.
The adapter uses the existing compiled definitions and schema validator, not a
second schema interpreter. These request/response fixtures do not establish the
native dispatch claim, credential owner, network transport or live interoperability.

The issue transport also reads header count/byte caps and connect/read/total/cancellation intervals from that same protocol artifact. Requests accept no caller URL, proxy, trust, header or retry override. The application response retention cap is separate from upstream HTTP parser allocation. A complete validated external outcome survives a same-poll cancellation race; an interrupted request with no complete result remains unknown.
