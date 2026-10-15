# M62.5–.5c personal client security review

The reviewed boundary is the optional personal-token MCP listener, its durable
session accounting, session-owned commits, and isolation from Cerebro's own
Claude Code runs. The per-run transport remains separate. All implementation
is unstaged and uncommitted at the owner's request.

The plan names a `security-review` skill. That skill is not installed in this
checkout or the available skill catalogs. This document records the concrete
review and regression evidence; it does not claim that unavailable skill ran.
The implementation received independent reviews from the parent agent and the
agent responsible for run-chain attribution.

## Threats and controls

| Question | Control and remaining boundary |
| --- | --- |
| DNS rebinding and browser Origin | Both transports share `loopback_refusal`. Only 127.0.0.1/localhost at the bound port and a matching HTTP Origin pass. Missing Host is 400; a foreign Host or Origin is 403. `/mcp` and POST are exact. No CORS permission or navigation surface is added. |
| Entropy and storage | Each token uses 32 OS-random bytes. SQLite and WAL receive SHA-256 alone. The create response is the only secret-bearing return, Debug is redacted, metadata carries no secret, and the global token cap is enforced in an immediate transaction. |
| Comparison and revocation | Every request rereads and revalidates all durable grants and compares every fingerprint without early exit. Session admission repeats the lookup inside its transaction. Revocation rejects later dispatches; calls already admitted may complete. A failed token read stops the current listener generation. |
| Log redaction | `cbr_` secrets are part of the existing diagnostic redaction vocabulary. Transport refusals log fixed reasons once per kind and never credential/header content. They do not create operational refusal rows without a session. |
| Tool and scope escalation | Client grants derive from the shared manifest's default/grantable toolsets. No UI-provided tool names become grants. Read scope and landing-path write scope meet the existing guards; Agent and Type records, Knowledge writes, preferences, proposals, and private hook tools stay unavailable. The client actor cannot use an Agent's own-memory exception. |
| Open-vault boundary | A data call needs the token's current canonical vault identity. Opening another vault revokes access before runtime registration, including failed opens. Protocol discovery for a closed vault returns no data and creates no session. |
| Session attribution | Admission inserts one run and stamps last-used in one transaction before dispatch. Initialization or 30 idle minutes opens another session. Idle/superseded sessions finish at their last call; cancellation uses the actual end. Model usage stays unknown. In-flight tickets defer ordinary close/settlement until a call completes. Orphan recovery handles a process crash. |
| Failed durable close | The closed session and its write claim remain pending for retry. No commit starts merely because an in-memory entry was removed. Quit releases claims without starting git and leaves a failed row for orphan recovery. |
| Body limits and pool exhaustion | Authentication precedes the 16 MiB body cap. Four workers bound concurrent dispatch. The server is local, not a hardened multi-tenant service: a local process can occupy sockets or compete for disk/SQLite. Fixed workers and a body cap bound work but do not eliminate denial of service. |
| Serialized writes and contention | Client calls pass through the same write serialization and path locks as run calls. SQLite admission uses an immediate transaction. No listener-state mutex is held while dispatching a tool or settling git. |
| Other local users/processes and copied tokens | Loopback limits network reach, not which local process can connect. A copied token grants its declared access until revocation. The other app's credential file is therefore part of the trust boundary; no secret is added to the vault or a standing Settings state. |
| Inherited or approved connectors | Client endpoint specs and specs containing a token are removed regardless of alias. Enabling access pins run MCP configuration and refuses while a live process inherited global config, even if that process is stopping. A setup mutex serializes this check with spawn/slot insertion. Spawn reads live listener configuration, so a damaged config file cannot weaken an enabled listener. Unrelated approved connectors remain available. |
| Session commits | Only write-capable sessions take a run claim. Their recorded paths remain owned through settlement and only those paths enter the commit, with run/actor trailers. Read-only sessions do not start settlement; quit never starts it. A client cannot use this mechanism to commit unrelated human changes. |

## Findings repaired during review

- Closed-vault initialization and tool discovery were initially rejected with
  data calls. They now return under a validated grant without a session.
- An old listener's failure could close newer sessions after unlocking. Stop
  and reconfiguration now mark their sessions atomically under the state lock;
  stale generations cannot stop a new listener.
- Failed durable closes initially discarded their accounting state. Pending
  closes now retain state and claims and retry from the sweeper.
- Enabling access during an already-running legacy connector session could
  expose a personal token. Enable/spawn serialization and the live-slot check
  close that transition without cancelling unrelated runs.
- Spawn initially reread configuration from disk. It now reads live state,
  preserving strict isolation even if persisted configuration becomes unreadable.

## Validation

Focused tests cover real loopback HTTP ordering and refusal codes, all-slot
comparison, transactional session admission, expiry and cancellation, failed
close retry, stale generations, read/write guards, run-port separation, and
session commits in isolated temporary repositories. The browser and mock lane
covers token display lifetime, snippets, status/port controls, reach, and
unavailable states. The focused Rust gate passed 370 tests (`cargo test -- client mcp::tests
runtime::dispatch::tests::every_production_runs_insert_names_its_cause`, with
the repository's Mac crash skiplist). This includes the unchanged transport
pool/address cases, both authentication-to-admission race regressions, and
all four session-commit cases. The frontend lane passed 585 focused tests,
57 shared name/grant cases, five browser flows and 105 state-lab tests.
IPC, author labels and convention pointers passed 86 additional checks;
the final pointer/IPC rerun passed 71. Full packaging and project-wide gates
remain the parent integration lane's responsibility.

No personal CLI configuration, installed application database, or live vault
was modified for validation. Optional owner-operated checks with Claude Code,
Cursor, or a packaged app remain separate from these isolated tests.
