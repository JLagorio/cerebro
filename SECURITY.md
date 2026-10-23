# Security

Cerebro is a local-first desktop app. Understanding what it does — and
deliberately does not do — with your machine is most of its security story.

## The trust model

- **No API keys, no cloud.** The assistant is the Claude Code CLI already
  installed on your machine, spawned as a subprocess. Cerebro never holds a
  model credential and never proxies your notes through its own servers.
- **Loopback MCP only.** The app serves its vault tools over an in-process
  HTTP endpoint bound to `127.0.0.1` on an ephemeral port. Each run gets its
  own bearer token as it spawns, handed to the CLI via a private
  `--mcp-config` file. The token is bound to that run's vault and grant,
  compared in constant time, and revoked 10 s after the run's process exits,
  or at once if the run never started. The endpoint has no token of its
  own, and the app's window never holds one. Each request must also be
  addressed to the endpoint itself: a Host other than `127.0.0.1` or
  `localhost` on the app's port, or a browser `Origin` other than `http://`
  and one of those, is refused before the token is read, so a web page
  cannot reach the endpoint by rebinding a domain name to 127.0.0.1 or by
  posting to it from its own origin. These refusals are answered and never
  recorded in `runtime.db`, as an unauthorized request never was; the
  diagnostic log notes the first of each kind per launch.
  `--strict-mcp-config` keeps the spawned agent from loading other MCP
  servers unless you opt in.
- **Other apps need a personal token.** This optional second MCP endpoint is
  off by default. It binds only `127.0.0.1`, normally port 37421; Settings
  accepts ports 1024–65535. Each `cbr_` token has 256 bits of OS randomness,
  appears once, and is stored only as SHA-256. At most 20 tokens exist per
  install. Every request rereads and validates the durable grant and compares
  every token fingerprint without an early match exit. Revocation prevents
  subsequent dispatches; an already admitted call may finish. A database read
  failure stops the listener. Host and Origin checks precede authentication;
  missing or invalid tokens get 401 with a Bearer challenge, and anything but
  POST gets 405 with `Allow: POST`. Only `/mcp` is served.

  Tokens hold the manifest's read toolset and only its explicitly grantable
  additions. Writes stay inside named folders; Agent pages, Type docs,
  Knowledge, preferences, proposals and the private approval hooks remain
  unavailable. Data calls work only for the open vault; initialization and
  tool discovery for another vault return no vault data and open no session.
  Each session has one attributed runs row before dispatch, with unknown
  model usage. It ends after 30 idle minutes, on a new initialization,
  revocation, a vault switch, access off, a port change or quit. A write-capable
  session holds its paths and commits only its own recorded writes when it
  ends; quit releases them without starting a commit. Failed durable closes
  retain their claims and retry instead of pretending the row finished.

  Any local process or user can contact this port, but needs a token. A token
  is as safe as the other app's configuration file; someone who copies it can
  exercise its grant until it is revoked. Cloud-hosted clients such as
  claude.ai and ChatGPT cannot directly reach this address. Cerebro ships no
  bridge for Claude Desktop. This reverses M6's private-only endpoint choice
  for this opt-in listener alone (D17); the run port and its bearer remain
  unchanged. Requests authenticate before their capped 16 MiB body is read.
  Four workers limit concurrent dispatch, but a malicious local process can
  still occupy sockets or contend for SQLite and serialized vault writes.

  Cerebro runs never inherit this personal-token connection. When access is
  enabled, even a failed bind pins each run's MCP config; explicit connectors
  carrying a personal token or naming the client endpoint are excluded under
  any alias. Unrelated approved connectors retain their ordinary grants.
  Enabling access is refused while a live process inherited global MCP
  configuration, including a process still stopping. A shared setup lock
  serializes run spawning with this transition, and spawning reads the live
  listener configuration rather than trusting a damaged config file to
  weaken isolation.

- **Recorded activity stays scoped.** `read_activity` reads operational page
  writes and runs through SQLite's read-only connection. Paths outside the
  run's read scope are withheld and counted, including comment sidecars and
  a run's written pages. A run's cause contributes only its fixed reason,
  never private subject or detail text. When Cerebro was open is vault-wide;
  the answer names that boundary and edits the app could not have recorded.
- **Sheet calculations are reads.** `read_sheet` and `calculate_sheet` need
  read scope only, so read-only personal tokens can use them. Hypothetical
  inputs and scratch formulas run on a private workbook on the capped engine
  thread; they change no page bytes, timestamp or write receipt. Large sheet
  blocks are shortened only in the note answer, while its hash and quote
  matching still use the complete saved bytes.
- **Sheet edits are checked page writes.** `edit_sheet` needs both read and
  write scope. It refuses knowledge/, Type docs and Agent records, checks an
  optional source hash, plans every operation on a copy, and computes the
  report on the capped engine thread while holding the page's path lock.
  A valid batch writes the page once with the run's actor and receipt;
  identical source writes nothing. Ask-first runs require a person's Allow,
  and unattended writes wait in Review. Only source formulas reach disk;
  computed values and errors are bounded, JSON-quoted page data in the reply.
- **Imported workbooks are untrusted files.** Only the file a person picks is
  read; its local path never reaches the webview. The reader refuses special
  files, caps the file at 32 MiB, and uses the shared Office archive boundary
  to verify part counts, duplicate aliases, encryption, XML and actual inflated
  bytes before IronCalc parses it on the capped engine thread. Preflight also
  caps declared array expansion and materialized string text, rejects nested
  string amplification and invalid numeric/boolean literals, and records missing
  formula caches as unsaved rather than zero. A parser panic or deadline refuses
  the import. Nothing is written before Import; it creates
  one new page through the receipted human batch door. The preview names
  unsupported features and any value differences. Workbook export computes
  bounded live fences into bytes before opening the native save dialog; no
  upstream path-taking export API is used. CSV guards formula-like text while
  preserving actual numbers and booleans.
- **Suggested views are previews.** A successful `suggest_view` answer writes
  nothing. Add is the person's own `human:me` batch, checked again against the
  current database. Placing a view appends one database fence to the open page
  in that same batch. One Undo restores both files while their versions still
  match; a preview cannot navigate, edit a record or save a layout.
- **Ending a run ends its process group.** The CLI runs as the leader of its
  own process group. Stop, a vault switch and quit send that group TERM, wait
  2 s, then send KILL, so what the run started inside the group ends with it.
  A process that starts its own session (`setsid`) leaves the group and
  escapes that signal; Cerebro trusts the CLI to end its own shells on TERM,
  which is why TERM comes first.
- **Tool permissions are enforced, not described.** Shell access in Settings
  is off, ask or on (M57.2), and one table,
  `shared/policy/tool-approval.v1.json`, turns it into what each run may do
  with the CLI's own tools. Off denies the built-in writers (Write, Edit,
  MultiEdit, NotebookEdit) and Bash in `--disallowedTools`, so the CLI's own
  edit auto-approval cannot write around Cerebro's guards. On pre-approves
  them and the built-in readers. Ask leaves the writers and Bash out of both
  lists and starts the run in Claude Code's `default` mode, so each call
  meets Cerebro's gate and waits for your card; a run whose start reports
  another mode or a Claude Code older than 2.1.250 is stopped before it acts.
  Ask asks only in a conversation you are watching: a scheduled run under Ask
  is denied those tools instead, and its run records which. This
  conversation allows only the exact command or path the card named, in
  memory, for that conversation. Your own Claude Code allow rules and hooks
  act before Cerebro asks, so a command they allow runs without a card, and
  Settings counts them beside the switch. A writer or the shell an agent's
  `allowed-tools:` leaves out is denied at every ceiling. A read-scoped run
  loses the shell and is denied the built-in readers (Read, Glob, Grep) too.
  Inside the vault the readers need no approval, except in the Trash, which
  every run's Read and Edit are denied, and mail, whose Read and Edit are
  denied to unattended runs (M60.8b, M69.7b, below).
  Every run names the only CLI tools it holds (M91.1): `--tools` lists the
  built-ins its plan allows, asks for or leaves to Claude Code, so one the
  table denies or refuses, or one a newer Claude Code adds, does not exist
  for the run, and each denied one also rides `--disallowedTools`. Every
  built-in Claude Code 2.1.250 offers has a row in the tool manifest, and a
  run whose start offers one Cerebro has no row for is stopped before it
  acts. Built-ins that reach past the conversation are denied on every run,
  watched or not: messages to your other Claude Code sessions (SendMessage,
  ListAgents), Claude Code's shared task list and background tasks,
  schedules and remote triggers, your own Claude Code skills, and tools that
  publish, notify or act outside the vault (Artifact, PushNotification,
  DesignSync, ReportFindings, Workflow, worktrees, SendUserMessage, REPL,
  MCP resource readers, LSP, Monitor). ToolSearch stays with every run: it
  only loads tool definitions Claude Code defers.
  The subagent tool (`Agent`, which an init lists as `Task`) is held only by
  a conversation you are watching while the Subagents switch is on; every
  other run is denied it in argv (subagents, below). A watched conversation
  keeps its todo list (TodoWrite), and every other run is denied it. Every
  run but an internal one carries one settings file, owner-only and removed
  with the run, that refuses Claude Code's bypass and auto permission modes.
  The plan tools are refused, by the gate or in argv; the question tool asks
  you only in a conversation you are watching (M57.3, below) and is denied in
  argv everywhere else. Web access is a second Settings ceiling, off by
  default (M57.7). Off denies WebFetch and WebSearch in argv, even when your
  own Claude Code settings allow them. On grants both to attended turns, and
  to scheduled agents whose record declares `tools: web`. Cerebro's own
  constructs and handed-off runs never get them. A fetch can carry vault text
  in its URL, so give the web only to agents you trust with the outside
  world. Cerebro's
  own internal runs (ingest, maintenance, synthesis and an agent's pre-run check) are denied every CLI
  tool that acts, the web tools and the subagent tool included, and hold only
  ToolSearch, to load their deferred Cerebro tools. Cerebro's MCP tools enforce the rest
  themselves: a run's write scope, its read scope, the knowledge guard, the
  note-corpus doors and an ask-first agent's Allow (next items). One write crosses a run's scope on purpose (D7): a
  run may rewrite the `recent` key, and nothing else, on its own Agent record,
  at most 30 lines and 4096 bytes, and every other byte of the record stays as
  the person wrote it, comments included. Every other key, and every other
  Agent record, stays refused. An agent's run can book later runs of itself
  only: at most 3 waiting, 5 minutes to 30 days out, under its own grant.
  These bookings live in the runtime database and never edit its Agent record.
  A write that names `expect_hash` is also a read, and
  is held to the read scope. The one tool that rewrites note text in place,
  `edit_note`, needs read access to the note as well as write access, because
  its refusals quote the note back, and so does `set_fields` (M60.4), whose
  list changes and option labels read the record as it is. `set_fields` never
  reaches `knowledge/`, a Type doc or an Agent record (its own `recent` key
  included), and it names a Type doc's or a project's options, or checks a
  linked page's type, only where the run may read them. `create_note` lists up to three similar
  notes as advice, and only notes the run may read (M61.6b). Its refusing
  form, `if_exists: "refuse"`, names a taken note in a folder the run may
  write, which the numbered copy it lands otherwise already reveals. Both scopes bind where a note path lands
  as well as how it is spelled, so a symlink inside a scope cannot carry a
  read or a write out of it. A vault's `allowed-tools:` can only narrow
  that grant, never widen it. A `scope:` or `read-scope:` that is present
  but names no folder (a bare key, a number, a mapping, a `[[link]]`) scopes
  the run to nothing, in a hand-off and a thread turn as in every other run
  (M58.6). The argv decides every call but one a run may
  stop to ask you about (next item): that tool is left out of the allow list
  and meets Cerebro's gate instead.
- **A run can wait for you, and only you can answer** (M57.1). A run that may
  ask carries one PreToolUse hook in its own settings file (owner-only,
  removed with the run). The hook rides the run's own bearer to Cerebro's
  loopback, and there it can only register a wait in its own conversation and
  read your decision; no MCP tool, hook or bearer records an answer. Your
  answer enters only through the app's answer command. A tool that may ask is
  never pre-approved in argv, so a hook that fails, times out or is switched
  off refuses the call. A call still waiting when you press Stop, switch
  vaults or quit is refused as not answered the next time its conversation
  goes on.
- **Subagents gather; the conversation you watch acts** (M91.1–M91.2d).
  Claude Code's subagent tool is held only by a conversation you are
  watching, whose gate can ask you, and only while the Subagents switch in
  Settings is on, as it is by default; each turn sends the switch as it
  stands when the turn starts. Off denies the tool in argv to every
  conversation, even when your own Claude Code settings allow it, and an
  agent with an `allowed-tools:` list that names neither `Agent` nor `Task`
  is denied it whatever the switch says, when you address it or bind the
  panel to it; an agent with no such list is not narrowed.
  Every other run is denied it in argv. A page's Access section says which,
  for the panel and for each agent.
  Such a conversation may start subagents of one type, Cerebro's
  `cerebro-researcher`. Its definition rides argv (`--agents`): the reading
  tools that conversation's own grant holds, its read and write scopes
  binding them, and WebFetch and WebSearch only where Web access is on; no
  writer, shell or connector, and no permission mode, servers, hooks,
  skills, memory or isolation of its own. It runs on its run's bearer, so
  every call it makes to Cerebro is the run's, under the run's grant, and
  is recorded as the run's. Every subagent hears the product brief, the
  server instructions and one line saying it works for the main
  conversation and can't ask you anything.
  Every run but an internal one starts Claude Code with the bounds in
  `shared/policy/subagents.v1.json`, in its environment and again as its
  settings file's `env`, which outranks your own settings' `env`: subagents
  run in the foreground, one level deep, at most two at once and eight a
  session, and Claude Code's built-in agent types and background tasks are
  switched off.
  Every other agent type is denied by name in `--disallowedTools`: Claude
  Code's built-in ones, and every one of yours Claude Code would load under
  `--setting-sources user`, the definitions under your Claude Code config's
  `agents/` folder and every installed plugin's, named as Claude Code names
  them. Cerebro reads those files for their names alone and logs nothing of
  them. When it cannot read one, cannot spell one in a deny rule, or meets a
  symlink in your agents folder that leads outside it, the run starts
  without the subagent tool.
  Three tripwires catch what argv cannot see. A run whose start offers an
  agent type its argv neither allows nor denies (an organization's managed
  agents, say) is stopped before it acts, on every start Claude Code
  reports in that process, a background task's continuation included. The
  conversation's gate holds every subagent start to the allowed type, never
  allowing one itself (argv's denials still bind), and refuses a subagent's
  own calls that would ask you. And one of the loopback's workers is kept
  for that gate, so subagents' reads cannot keep it waiting.
  What fails open is bounded: a definition you add while a run is under way
  reaches Claude Code without a new start, so only the gate holds it, and a
  gate that cannot answer in its ten seconds leaves the call to argv, which
  does not name it. Such a subagent still runs inside its run: the run's
  argv denials, its bearer and its grant bind it as they bind the run, and
  its Write and Edit calls commit with the run, as the run's own do.
- **An ask-first agent's page writes wait for your Allow** (M57.4). An Agent
  record that says `ask-first: true` (any value but `true` or `false` reads
  the same, failing closed) has its page writes, the tools the manifest marks
  `confirmable` (create, append, edit and frontmatter on notes), shown to you
  on a card before they land. Rust reads `ask-first:` from the agent's own
  record when its run starts, so the app's renderer can only tighten it.
  Cerebro's dispatch is the boundary: such a write reaches disk only by
  taking an approval the app's answer command recorded when you pressed
  Allow, bound to its vault, Claude Code session, agent, tool and input,
  used once and good for ten minutes. Your own Claude Code allow rules
  and hooks can make the CLI call the tool sooner; they can never approve
  it, and a write with no approval is refused and recorded against its run.
  A run nobody watches cannot ask, so an ask-first agent's page writes wait
  for you in Review instead (M57.4c, next item). Its own `recent` notes
  never ask (D7).
- **A page write queued for Review touches nothing until you allow it**
  (M57.4c). Pending writes live in `runtime.db`, in the app's data folder,
  outside the vault and outside git, and hold the agent's draft verbatim,
  with the grant of the run that queued it. A write is queued only once it
  passes every check it could pass then, on the bytes on disk; nothing
  reaches disk before you press Allow. Allow re-runs every guard under the
  queuing run's stored grant (its write and read scopes, its tool grant, the
  note corpus, the knowledge bundle, Type docs and Agent records, and a
  stale hash) under the write's own lock, and it never queues the write
  again; a second decision is refused as already decided. Your edit there
  is checked the same way and records nothing. One agent may have at most
  20 writes waiting, of at most 256 KiB each; nothing expires. The agent's
  next unattended run is told what became of each, once, with your reason
  and every vault path quoted as data.
- **You may edit an ask-first draft before Allow, and the edit never widens
  the agent's grant** (M57.4b). The card's form is projected from the tool's
  input schema. Rust re-checks your edit when you answer (its shape against
  the schema, then the run's write and read scopes, its tool grant, the note
  corpus and the knowledge bundle, under the grant the run was started
  with, and since M57.4c the write itself previewed on the bytes on disk),
  and a refusal comes back to the card and records nothing. It is
  checked again at the write, under the write's own lock, with the same
  guards as any agent write, Type docs and Agent records included. The
  approval holds the asked input's hash and your version; dispatch lands
  your version whichever of the two the CLI sends, and tells the agent which
  keys you changed.
- **The agent's questions are yours to answer, and only as text** (M57.3).
  When an agent asks you a question mid-turn (Claude Code's AskUserQuestion),
  its questions, options and previews are the agent's words: the card shows
  them as plain text, never as HTML, and a preview stays folded until you open
  it. Cerebro checks your answer's membership and counts (every question
  answered once, every pick one of its options, Other at most 2000
  characters with control characters removed) before it reaches Claude Code,
  as the call's own input. A question set the card cannot show is refused,
  and the agent is told why. The permission prompt tool Cerebro names on a
  run you watch allows only a call you answered, and refuses every other. A run nobody watches is never offered the tool,
  and every unattended run's message says that nobody will answer.
- **A turn you closed the panel on is held in memory, never on disk**
  (M57.6). Closing the assistant or switching threads leaves a run going,
  so its events are held for the panel to re-attach: only a run you watch,
  at most 4 MiB and 20,000 events a run and 16 MiB in all, for 30 minutes
  after it ends or after its waiting card closes. They are never written to
  disk, and are dropped at a vault switch and at quit. A re-attach names the
  run's durable id, so a run number reused after a restart reads nothing.
- **A vault checkpoint cannot commit a parent repository's staged files.**
  For a vault nested in a repository, its checkpoint builds a private index
  from the current commit and replaces only the vault's entries with their
  staged state. Outside staged and unstaged files stay untouched. Publishing
  compares HEAD atomically and refuses if another process moved it; an active
  parent merge, rebase, cherry-pick, revert or sequencer also refuses before
  staging. Tree/index path streams are byte-exact and must reach EOF without
  a read error. A changed filename that cannot be represented as UTF-8 is
  refused for handling in Git, rather than silently renamed.
- **Untrusted vaults cannot add callable servers.** A vault's
  `.cerebro/connectors.json` travels with the vault, so a stdio connector
  entry could name an arbitrary command, and an http one a server of the
  vault's choosing. An entry therefore reaches a run only after a person
  approves its exact spec on this machine: name+command+args+env for stdio,
  and for http its name, URL, headers and, when present, `oauth`. Settings
  approves what it adds; a hand-edited or downloaded entry waits for Approve,
  and any edit asks again. Approvals live
  outside the vault, as SHA-256 digests, never the specs themselves, since env
  values and headers are credentials. Connector credentials are kept out of
  git by per-entry self-healing ignore rules. `connectors.json` is written
  owner-only (0600), and opening a vault narrows one an older build left
  readable, but it stays plaintext at rest: anything that can read your
  account's files can read it.
- **An http connector reaches Claude Code as type, URL, headers, oauth and
  timeout, and nothing else** (M69.1). `headersHelper` would run a command,
  `tools` and `toolPermissions` would pre-approve tools past the run's grant,
  and the rest is Cerebro's to set, so none of them is passed. `oauth` is part
  of what you approve, because an `authServerMetadataUrl` can send the
  sign-in to another server and `scopes` widen what it grants; it passes only
  `clientId`, `callbackPort`, an https `authServerMetadataUrl` and one
  `scopes` string, never a client secret. An entry whose `oauth` or `timeout`
  Claude Code would refuse is left out of the run, so it cannot make the CLI
  refuse every other server with it. The Linear and Notion presets sign in
  through Claude Code's own `/mcp`, under the name the preset writes; the
  token stays in Claude Code's keychain entry and never in Cerebro. Removing
  an entry never signs you out: clear its authentication in `/mcp`.
- **Connector tools are granted by name, and records only subtract.** A run
  may call a connector's tools only when the connector is listed, enabled,
  approved on this machine and left in by the run's record; Cerebro then
  passes it in `--allowedTools` as `mcp__<name>`, spelled the way Claude Code
  hears the server name. An Agent record narrows that with `connectors:`,
  with `mcp__<name>` or `mcp__<name>__<tool>` entries in `allowed-tools:`,
  and with `disallowed-tools:`, which keeps a whole server from loading or
  passes a tool in `--disallowedTools`; none of the three can add anything.
  A run nobody watches reaches only the connectors its record names, so a
  scheduled agent without `connectors:` reaches none. Cerebro's own internal
  runs and handed-to runs reach none. Server names that could be read as
  another server's (one holding `__`, starting or ending with `_`, longer
  than 40 characters, or Cerebro's own name in any case) are refused, and so
  are two names Claude Code would hear alike. Every entry Cerebro puts in
  argv holds only letters, digits, `_` and `-`. With no `connectors.json`, a
  turn you watch loads your own global MCP config while personal client access
  is off, but Cerebro grants none of its tools. When client access is enabled,
  every new Cerebro run uses only its per-run MCP config, even if the client
  listener failed to bind. Turning access on waits until runs that inherited
  global connectors have finished; setup and enable share one lock so a
  starting run cannot slip between that check and the listener opening.
  Explicit connectors carrying a personal token are
  excluded under any name, including tokens in stdio arguments or environment
  values. The configured client port's `/mcp` endpoint is excluded regardless
  of its hostname, so a DNS alias cannot bypass this boundary. A turn that
  names a connector anywhere (`connectors:`,
  `allowed-tools:` or `disallowed-tools:`) loads none of it, because a bound
  on a connector holds only against the vault's list. Your own Claude Code
  allow rules still apply to every run and can widen a record's tool-level
  allowlist for a server; a deny always wins, so a read-only agent should
  also deny the destructive tools, spelled exactly as the server names them.
  A denied tool is withdrawn from the run, so the model never sees it; a
  call to a loaded tool outside the grant is refused by Claude Code and
  recorded, by tool name, under its run in `runtime.db`.
- **The knowledge bundle is write-guarded.** `knowledge/` accepts writes only
  through `write_concept` (which stamps provenance server-side and refuses
  self-certification), `recheck_concept` (which moves `stale_after` and
  nothing else, and refuses a concept a person verified) and `verify_concept`
  (scoped to the `verified` key).
- **Every write says who made it, and an agent cannot write as you**
  (M58.1). Each vault write carries a receipt its door's guard mints: your
  commands stamp `human:me`, an agent's tools stamp the run's actor and run
  from its grant, and a write you allowed names you as its approver while
  keeping the agent as the actor. Only the commands the app's window calls can
  mint your receipt; no MCP tool reaches that guard, so no agent write is
  recorded as yours. The record is operational, in `runtime.db`'s
  `vault_writes`, never the vault's ledger, and it observes writes without
  gating them. Writes that pass no door (another editor, a sync, git, an
  agent's own shell) record nothing, and a run whose plan let the shell run
  says its record may be partial.
- **A page's comments live beside it, in `.comments/`** (M70.2). Each page's
  threads are `.comments/<page path>.json`; no comment ever writes the page
  itself. Git carries that folder like any other, so a pushed vault shares
  its comments. The scan, search and the agent's note tools never read or
  write it, and a sidecar linked out of the vault is refused like any escape.
  A link inside the vault is refused too: when `.comments`, a folder in it or
  a sidecar is a symlink (to `.git/`, `.cerebro/` or `knowledge/`, say),
  comment reads and writes refuse, and a rename or delete leaves the comments
  where they are rather than carry, clear or trash through the link.
- **A deleted page waits in the vault's own Trash, `.trash/`** (M60.8). A
  delete moves the page and its comments to `.trash/<stamp>/`; nothing a
  person deletes is unlinked. `.trash/` is gitignored, so a pushed vault
  never carries a deleted page, and the scan, search and Cerebro's agent
  tools never read or write it. Neither do Claude Code's own (M60.8b): every
  run a person or an agent starts denies `Read(./.trash/**)` and
  `Edit(./.trash/**)` in `--disallowedTools`, from the tool-approval table's
  `hidden_paths`, and a deny beats any allow, your own included. Claude Code
  applies a Read rule to Glob and Grep as well. A shell-granted run can still
  reach `.trash/` through Bash. Restore refuses to overwrite, a `.trash` linked out of the vault is
  refused like any escape, and at launch items past 30 days move to the
  macOS Trash.
- **An unfinished change keeps its pages' previous bytes in `runtime.db`**
  (M60.6). A database-wide change (a property rename, kind change or copy,
  a bulk delete) writes a journal row holding every page's previous bytes,
  in the app's data folder, never the vault, before it writes a page. The
  row is deleted the moment the change commits, or once a rollback puts the
  pages back, which the next launch does for a change that stopped partway.
  A change refuses knowledge/, and refuses to start without that journal.
- **Agents can comment on pages they can read** (M70.3). comment_on_note,
  reply_to_comment and resolve_comment write only the page's comment
  sidecar, never the page, and are held to read scope (a refusal lists where
  a quote appears, so it is a read) and to the tool grant, not to write
  scope. A run posts at most 20 comments. Comment text reaches agents quoted
  as data.
- **A person's @mention in a thread runs one turn** (M70.4). A person's
  comment that names an agent runs one turn of that agent, under its own
  scope, read scope and tools, with no shell, web or connectors, booked to
  Fleet with the page as its cause. Only a person's comment starts one; an
  agent's comment never does. Cerebro posts the answer in place of the
  placeholder, and a deleted placeholder drops it. An agent that cannot read
  the page is not asked, because the question quotes the page.
- **Claude Code's session files are read back, never copied** (M56.3).
  Claude Code writes each conversation's transcript under its own config
  folder, keyed by the vault's path, outside the vault. Cerebro reads a
  vault's session file back, read-only, to rebuild a thread whose cached copy
  is gone, folds it as it reads, and stores no new copy of it; the
  transcripts a session's subagents keep beside it, under
  `<session>/subagents/`, are read the same way (M91.3b). A session id
  is accepted only as a lowercase UUID, before any run starts or any path is
  built, so a stored id can neither become a Claude Code flag nor reach a
  file outside that vault's projects folder. A branch (M91.6) names the
  session it starts from and the line it starts after in the same shape;
  Rust checks that line against the source's file, read-only, before
  anything runs, and mints the branch's own session, so the source is only
  read.
- **A run's detail folds its session file only when asked** (M56.9). Claude
  Code keeps session transcripts under its own `projects` folder, outside the
  vault, and Settings names and purges them. A run's detail reads that file,
  read-only, when you open its Transcript; Cerebro stores no copy, and after
  Claude Code's cleanup (30 days by default) the run says so. The fleet reads run history
  through a connection SQLite opens read-only.
- **A model and an effort reach argv only after Rust checks them** (M56.5).
  An Agent record's `model:` and `effort:`, and a conversation's pick, become
  `--model` and `--effort` only after `src-tauri/src/agent/run_options.rs`
  has checked them against `shared/policy/run-options.v1.json`: an effort
  must be one of its five levels, and a model name starts with a letter or
  digit and holds only letters, digits and `._-:@/[]`, at most 128 of them,
  so no value can be read as a flag or carry a space or a control character.
  The check runs before any token, lease or run row exists, again before a
  handed-to run starts, and again before the child is admitted. Each value
  is its own argv element, never passed through a shell.
- **A vault cannot choose who the panel answers as** (M56.6). Settings binds
  a vault's assistant panel to an Agent record by its handle, and the binding
  is the app's own `config.json`, keyed by vault path, never a file in the
  vault. A handle outside the slug grammar is refused before anything is
  written. A bound turn runs under that record's grant, like a turn that
  names it with `@`: its actor, write and read scope, tools and connectors,
  under the Settings shell and web ceilings, and a paused agent's turn is refused. A
  binding no record answers to sends as the plain assistant, and the panel
  says so.
- **Open with preserves its note and agent-link boundaries.** A markdown note
  inside the vault, judged by the note writers' own door (no dot-paths,
  non-notes, `views/`, `attachments/` or symlinks out), which Finder reveals or
  the default app opens; or a link built from one of the four agent-link bases
  in `shared/policy/agent-links.v1.json`, with the prompt percent-encoded and
  the whole link at most 8192 bytes. Each goes to `/usr/bin/open` as one
  argument, never through a shell, and the clipboard is written through
  `/usr/bin/pbcopy`. A prompt carries the page's vault-relative path, never
  its absolute one, so a link to claude.ai does not carry your home folder's
  name (M55.9).

- **Opening files is a guarded desktop action** (M66.4). Every action opens
  a contained file descriptor through the bytes door. Open reads the kinds
  table against that descriptor, refuses executable-like content, and asks
  a native confirmation for unknown kinds. It passes a transient macOS file
  reference URL made from the descriptor as one argument, so replacing the
  pathname cannot substitute another file. The original remains editable;
  no snapshot is substituted. The verdict is checked again after a dialog.
  Reveal and Quick Look recheck the canonical pathname's identity before
  dispatch, and never execute the target. This native pathname handoff cannot
  exclude a later rename by another application. Quick Look has one child, killed
  on replacement or quit and reaped when it closes. Save a copy reads the
  pinned source descriptor and stages in an anchored destination directory;
  the chosen destination may not be inside either the initial or current vault, or the source
  itself, including aliases. Its final rename never follows a destination
  symlink or writes through an existing hard link. These actions do not
  create vault write receipts or operational history. External processes can
  still modify an inode or move a directory concurrently; pathname checks
  are not a filesystem transaction against other applications.

- **App links only navigate** (M65.6). `cerebro://open` and `cerebro://go`
  are untrusted input: Rust bounds and parses them, rejects traversal and
  duplicate known query keys, and resolves optional vault ids through the
  read-only local registry. A link cannot name an arbitrary vault directory.
  The webview waits for a ready scan, requires an exact existing page, and
  asks before switching vaults. Missing or malformed links create nothing;
  links never write pages, approve actions, or start agents. The latest
  launch link waits until the listener binds and is taken once. Later links
  arrive through the same navigation-only host. Copy Cerebro link includes
  a local vault id and relative page path, never an absolute vault path.

## Mounted repositories (M30/M32)

Cerebro can mount additional directories — typically work repositories —
beside the vault. The trust model for a mounted root:

- **Cerebro exposes no mounted-root tools to the agent.** MCP tools are
  vault-scoped; none of the `root_*` commands are agent tools. Scope this
  claim honestly: with the shell ceiling enabled, the CLI's own tools
  (Bash/Read/…) reach anything your user account can read, mounted or not —
  this decision governs Cerebro's guarded surface, not the operating system.
  Mounted repositories may contain code the user does not have the right to
  share (employer code); widening Cerebro's surface is a deliberate decision,
  not a default (see below).
- **Reads are guarded**: path containment after canonicalization, a 2MB
  ceiling, binary sniffing (`src-tauri/src/roots/read.rs`).
- **Git operations are read-only plus fetch/fast-forward pull.** Cerebro
  never commits to, pushes from, or resolves conflicts in a mounted
  repository; a pull that would need a merge is refused (`--ff-only`); and
  sync refuses a root mounted inside a larger repository (`parent_repo`) — it
  would act on a repo you never mounted. Auth is system git's: Cerebro stores
  no credentials, and its readiness probe only asks `git credential fill`
  (from outside the repo, so the repo's own credential helpers never run)
  whether auth WOULD succeed. Cerebro pins off repo hooks and the
  `ext::`/fsmonitor vectors for every git it spawns, but fetch/pull
  necessarily run inside the repository and git honors that repository's
  remaining configuration there — **mounting a repository is an act of trust
  in its `.git/config`.**

**Decision (M32.12): agent exposure of mounted roots is OFF.** Revisiting it
requires, in one PR: root-scoped read-only MCP tools granted per run like
every other tool (an Agent record's `allowed-tools:` and `read-scope:` must
be able to exclude them), per-call root resolution with ambiguity-as-error
for anything write-shaped, and an update to this section. The guarded read
path was built MCP-ready precisely so that PR is small — the barrier is this
trust model, on purpose.

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository (GitHub private
vulnerability reporting is enabled) for anything sensitive — it opens a
private advisory only you and the maintainer can see. For anything that does
not expose user data, a public GitHub issue is fine. Include steps to
reproduce and what a successful exploit would reach. There is no bounty
program; there is a genuine intent to fix what you find.

## Out of scope

- Anything requiring an already-compromised machine or vault ownership.
- The Claude Code CLI itself (report to Anthropic).
- Denial of service against your own local app.
- Cloud coding agents, GitHub App webhooks and server-side code execution:
  Cerebro ships none of them.

- Checked view suggestions (`suggest_view`, M62.4) resolve one database from
  readable Type docs and validate against its readable ordinary records.
  They write nothing and emit no navigation or UI event. Refusals name only
  readable fields/options and record one operational `schema_invalid` row
  per run, tool and database. The user alone chooses whether to add a view.
- Structured database reads (`describe_database`, `query_records`, M62.2) and
  `list_agenda` (M62.3) use
  only records and Type docs inside the run's read scope. Withheld notes are
  counted across the vault, never named or used to infer field names or options.
  Agent memory, preferences and recent notes are absent from query values.
  Agenda reports stored date values in the requested interval, marks repeat
  series without expanding them, and makes no availability judgment. These
  tools write nothing and create no operational refusal rows.

The starter kit is offered explicitly, once per empty vault. Its shipped agents
are paused and scoped; installation writes only the compiled kit paths in one
create-only human batch and an owner-only `.cerebro/starter.json` marker. It
refuses an existing page or previous offer, and rejects symlinks in the marker
and its parent. A marker failure after a successful batch is reported without
rolling back the person's new pages.

A write by an agent run that wakes another agent is a chain hop: two hops, no
cycles, the root's chain allowance and the day budget. A write Cerebro did not
record wakes a root that only the cooldown limits.

### Contained media and PDF bytes (M66.2)

Native file drops reach only the webview commands `inspect_dropped` and
`read_dropped_text`. They read the absolute paths the person supplied, with
text restricted to capture kinds under the shared 4 MiB cap. Folders and
nonregular files are never read as text. Attachment copies use the human
write door. No MCP tool exposes either outside-path reader. UI continuations
check their page and vault lifetime after each asynchronous read or copy;
switching vaults discards the pending result.

The main webview reads image/audio/video rows through `cerebro-file:` and PDF
rows through raw `read_file_bytes` IPC. Root `0` resolves the current vault;
other IDs resolve mounted roots. Validation and the final read share a
contained open descriptor, so a symlink swap cannot redirect the read.
Bodies stop at 64 MiB; a single range returns at most 1 MiB. Responses send
no-store and nosniff, never CORS. The optional opaque cache revision changes
only WebKit's resource identity. CSP admits the scheme to images and media
only; the existing navigation guard refuses it. These refusals are UI values
and are not written to either record or the diagnostic log. Text reads keep
their 2 MiB cap.

### PDF rendering (M66.5)

PDF bytes enter through the contained, bounded bytes door. Only the isolated
loader imports PDF.js; its worker starts on first use. The library, worker
and viewer are the same exact upstream `pdfjs-dist@5.7.284` release. Its
[legacy target is Safari 16.4](https://github.com/mozilla/pdf.js/blob/v5.7.284/gulpfile.mjs#L80-L102),
which covers macOS 14's WebKit 17; 6.x raises the legacy floor to Safari 18.
This supported-platform choice deliberately supersedes the plan's newest
release rule. No patched fork or application polyfill is shipped. The browser
proof removes the newer Promise, AbortSignal, Set and Uint8Array APIs before
opening a PDF, exercising upstream's own compatibility code.

[GHSA-hq66-cqwq-w95j / CVE-2026-16633](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)
affects this release when PDF scripting is enabled and the host lacks a script
CSP. Both upstream mitigations are enforced here: there is no scripting
manager or sandbox import, `PDFViewer.enableScripting` must remain false,
and the webview's strict script policy remains in force. The older
CVE-2024-4367 fix predates this pin. This release has removed document eval
and the `isEvalSupported` option; no ignored option is passed. XFA, wasm,
annotation editing and automatic link detection are disabled. The page API
filters annotations to links before constructing widgets. External links
carry `noopener noreferrer` and still meet the native navigation guard.

The only CSP addition is `connect-src 'self'` for bundled cMaps and fonts;
worker and decoder scripts already fall under `default-src 'self'`. The asset
plugin serves and emits only the package's cMaps, standard fonts and decoder
folders, by an exact URL allowlist. CSP diagnostics contain the directive
and blocked origin, never a file path, query or data payload. Print opens the
original file in its desktop app through the guarded file-action door.

### Attachments (M66.6)

The human attachment doors accept selected, pasted or dropped files up to
50 MB. They reject hidden names and folders, copy only into the exact
`attachments/` directory, and never follow a redirected directory or a
candidate symlink. Unix placement uses a pinned directory descriptor and
exclusive installation. Copies have no execute bits; macOS copies retain
quarantine protection through the system xattr copier. Data is streamed
under a bound even if the source grows during the copy. Identical bytes are
reused only within the requested name family and produce no second write
record. Reuse leaves existing metadata unchanged, including its quarantine
attributes; only a new copy inherits the incoming protection. Importing opens
nothing. The editor checks its page and vault owner
again after every asynchronous read/copy before placing root-anchored links.
The assistant's composer copies an attached file in through the same doors
when its message is sent (M91.17), and the run is told the copy's vault path
and kind, never the path it was copied from; one Undo moves the send's new
copies to the vault's Trash.

### Office extraction (M66.7)

Office readers use a contained file descriptor and never run macros, fields,
external relationships or embedded programs. Package entry counts, actual
inflated bytes, XML depth and node counts are bounded before workbook parsing.
Workbook cells stay sparse. Allocation-driving shared-string counts and shared
formula indices are checked by exact XML attribute identity before calamine
opens the package. Repeated strings, numbering, links and picture metadata also
consume a retained-data budget; repeating a small reference cannot expand into
unbounded materialized content. Repeated inflation has a separate work cap.
Unreadable, encrypted, oversized and unsupported files have distinct outcomes.

Imported pages carry source identity and import time in their own frontmatter.
They register as content-only under `vault-import-v1`, never as the owner's
assertion and never by changing the identity of an already recorded item.
Every ordinary agent note door preserves import and fetch stamps, comparing
key presence and YAML value under the path lock before writing. Queued and
person-approved calls pass the same guard. `cache_source` and `write_concept`
are the stamping writers; people may still edit these fields. Shell tools
and edits made outside Cerebro do not pass this note-door guard.

### Document captures (M66.7c)

Inbox document captures (M66.7c) first keep the selected original through the
attachment door, then read that kept file under the Office limits above.
PDF text uses the same bundled PDF loader as the viewer, with scripting and
document eval absent. Extraction visits at most 300 pages, waits at most ten
seconds per page and two minutes overall, and retains at most 1 MiB of text.
The worker document is destroyed after success, failure or timeout. Extracted
text is escaped so it cannot introduce live links, HTML or editor directives.
Every outcome, including no text, encryption and corruption, keeps the original
and records imported-content provenance. The capture door checks its vault
after every awaited read and serializes duplicate decisions within that vault.

### Document reads (M66.8)

`read_document` is an optional read-toolset capability, including personal-token
clients. Its manifest target is a contained file on the read axis with no write
door. Scope applies before the body and again to the canonical file pinned by
the descriptor. Hidden paths and paths outside the vault refuse before parsing.
The selected text carries a content-derived data fence and taint signals; no
prompt adds this capability to a narrower grant. Pictures are opt-in, selected
with the text, and at most eight are decoded. Each input is capped at 32 MiB;
`image::Limits` bounds each side to 10,000 pixels and allocation to 256 MiB.
Output never exceeds 1080 pixels on its longest side or 2 MiB encoded. Alpha is
kept in PNG; a PNG exceeding the encoded cap is flattened onto white for JPEG.
No remote image or external relationship is fetched.

### Whiteboard reads (M68.7)

`read_canvas` is a read-toolset capability, available to personal read tokens.
Its canvas target requires read scope before bytes and again on the canonical
path of the contained descriptor. Dot paths and climbing refuse. The reader
opens one `.canvas` file, capped at 8 MiB before allocation; its response has
separate shared node and byte caps, and explicitly reports cuts and continuation.
Invalid or unsupported boards refuse instead of appearing empty. File cards
are checked for existence only within read scope; no card file is opened and
no link is fetched. Node text, labels and links remain untrusted board content.
Reads change no file and record no vault write.

### Pictures on scoped note reads (M66.8b)

A note read attaches pictures only when the run declares a read scope. Each
picture must pass that scope on its requested path and its pinned canonical
path, and the contained descriptor refuses hidden paths and vault escapes.
The media-line grammar and relative/percent-decoded destination resolver replay
shared cases with the page's TypeScript reader. Fenced code is inert. No URL
or inline data image is fetched; schemes, network paths and encoded schemes
are counted as remote. Duplicate destinations are attached once.

At most eight allowed pictures are decoded, each through the bounded image
reader described above; corrupt attempts consume this budget too. Each returned
picture is at most 1080 pixels on its longest side and 2 MiB encoded. A note's
header plus body over 40,000 characters attaches none and says why. Counts and
captions join the header before its separator; body bytes stay unchanged.
Unscoped reads retain their prior answer exactly. Decoder/read failures are
counted explicitly, rather than presented as no pictures.

## Mail storage and admission

Mail pages under `sources/mail/` and their `.comments/sources/mail/` sidecars
stay out of git. A checkpoint repairs older tracked copies by removing them
from the index while keeping the files on disk. Case variants are also
excluded. Run commits report how many mail files they kept out. This does
not erase content from older commits.

Correspondence is derived from declared email/domain fields and readable mail
headers; opening the unfiled lane writes no addresses into the vault. “Not a
person” and “Not a company” store normalized address/domain dismissals in this
Mac's runtime.db, scoped to the vault, never in tracked files or the ledger.
Restore removes that local row. Explicit “Create page” writes the chosen
address into a tracked page; its button title explains that change. The lane
measures matching sent-to threads, not per-address message counts or names
that the header cache does not record.

The shared mail artifact ships with its Gmail gate closed. The draft evidence
pack at `docs/superpowers/evidence/triggers/R14/2026-10-15-gmail.md` describes
header digests and explicitly requested message text. Opening the gate
requires the owner's dated, fired pack, R14 registration and an identical
vault-store scope; build tests check that agreement. Runtime code does not
consult the evidence registry. Acceptance is separate from implementing the
closed-gate features.

Thread header digests hold normalized participants, SENT-derived direction,
message ids and timestamps; BCC, drafts, labels and message bodies are excluded.
Headers are escaped before entering markdown. The gate binds the exact vault
store and attendance, and ordinary agent note doors cannot write the mail
folder. A refresh compares under its path lock, skips unchanged metadata/body,
and refuses an existing page with another source identity. The source writer
checks the actual landing before directory creation and again under the lock:
a symlink cannot redirect private mail into a public folder or a web cache into
mail. Metadata must remain readable under the scanner's size limit.

Requested message text needs the separately listed `thread_text` kind in the
same scoped gate and an attended conversation. The request requirement is a
prompt rule; the gate, attendance, limits and private folder are enforced by
Rust. Text is cut to the reply (forwards stay whole), escaped, and written to
its own `-text.md` page. An over-limit call or conflicting page identity writes
nothing. Both paths are locked before checking for existing text and building
the header link. Each changed file lands by atomic rename with its own receipt;
an I/O failure between the two renames can leave the text page without the
header update, which a subsequent refresh repairs. A header-only refresh never
rewrites the text page.

The optional Mail sweep record is born paused, with no trigger or schedule. It
grants only the selected connector's `search_threads` and `get_thread`, and
only the vault's source cache door can write. The prompt requests metadata
only and reports connector failures and limits. Its explicit denial list
includes draft, label, trash and spam operations; the positive allow-list also
withholds unlisted tools. Legacy denial names remain compatibility guards and
are not claims that every current server provides those tools. No background
mail sync is installed. Retention runs only from the person's Settings action:
one hash-checked batch moves old digests and matching text pages into vault
Trash, with one Undo. Undated, unreadable and mismatched pages are retained.

Unattended runs and token clients cannot read `sources/mail/` through
Cerebro's targeted readers; listings withhold the pages and report the count.
Ambient ingest excludes the folder before opening its files. Unattended CLI
Read and Edit are denied that folder at every ceiling. Grep and Glob follow
those Read rules only as far as Claude Code applies them; a shell grant can
still run commands over files (D6). Attended Cerebro conversations retain
read access within their declared scope.

On every connector server the run loads, unattended argv denies the five
mail readers named in `mail.v1.json`. This is an exact-name boundary: a
server spelling a reader otherwise, or legacy mode without `connectors.json`,
is not covered. Mail URLs are refused before the ticket/web cache scans or
writes, and external-reference discovery never asks to fetch those links.

### Derived file previews (M66.9)

Thumbnails use contained descriptors and live only in the app cache, outside
vault writes and runtime history. Cache identity includes canonical path, byte
length, nanosecond modification time and snapped size; an external replacement
preserving those values can reuse the prior preview. The cache prunes oldest
entries past 256 MiB. Typed permanent negatives are cached; missing files,
missing tools and timeouts are retried. Preview input is capped at 64 MiB.
Embedded PSD and Figma previews use checked lengths, and ZIP entries pass the
same bounded package reader as Office extraction. Raster decoding stays in
`images.rs`, with 16,384-pixel sides and a 512 MiB allocation limit. Outputs are
at most 512 pixels and 512 KiB. At most four decodes and two Quick Look workers
run together. Quick Look receives a private, non-executable copy, never a
replaceable vault pathname; it runs only for the closed extension list and
never a denied kind. Its output is capped at 4 MiB; a five-second timeout kills
and reaps its process group. Ordinary completion removes the private copy;
before another Quick Look job, stale work directories older than a minute are
removed without following symlinks, recovering copies left by a crash.

### Notion imports (M69.5)

The live CLI fold captures only the exact `notion-fetch` name of a connector
server granted to a run that also holds `import_notion_page`. Server and exact
tool denials both prevent capture. Results remain in memory under that run's
lease: at most eight captures per run, 4 MiB each and 16 MiB across runs. Debug
output and transcript events never carry this retained copy; normal existing
bounded tool previews remain. Run completion, stop/drain, init refusal and
unwind retire the lease. Session-file replay never arms it.

The import tool accepts a page identity and landing folder, then reads that
run's latest matching capture. Unknown markup, failed fetches, databases and
incomplete envelopes refuse before writing. Only a composable refusal can
license a model-authored fallback, and only for the same captured generation;
that fallback is visibly stamped `import_method: agent_composed`. Refusals
record one operational row per run, reason and page, without captured text.

Imported copies are selected by canonical source identity; their actual
landing must pass read, write, corpus and provenance checks. Both lexical and
resolved locations obey the mail read boundary, and an alias cannot land an
import in `sources/`. Existing files compare their scanned bytes under the
path lock. Automatic link repair changes only prose on readable, writable,
unchanged imports; edited or unreachable citers remain untouched. No media
bytes are downloaded. Browser tests use explicit Rust-normalized outcomes;
they do not claim to prove a live connector's envelope or packaged rendering.

`edit_canvas` requires read and write scope on its board, refuses Knowledge
and hidden paths, validates every operation before one path-locked write,
and preserves unknown JSON keys and Cerebro extras. `expect_hash` compares
under that lock. New or repointed edges must name existing nodes, including
nodes added earlier in the batch. File-card existence is checked only in
read scope; no linked bytes or web content are fetched. A missing file keeps
its pointer with a warning. A canonical path outside the vault refuses.
`create_canvas` applies the same planner to the empty board after choosing
and locking its final free filename. Its folder is write-scoped, Knowledge,
mail and hidden destinations refuse, and file-card probes remain read-scoped.
A failed operation creates no file or receipt. An allowed batch records one
create, including when a taken name requires a numbered suffix. Both canvas
writers use the same ask-first admission and queued-review boundaries as
other confirmable writes.

### Remote images (M66.9b)

HTTPS image loads require a person's click for that exact URL in the current
session. The allow-set is memory only. HTTP and protocol-relative image URLs
never load. Requests have no referrer and use the browser directly; Cerebro
runs no image proxy and Rust makes no remote-image request. Page icons and
avatars keep their glyph/initial fallback for remote sources; gallery URL
covers remain named tiles. The editor's live node has the same gate, while
save/copy/drag exports assign lazy loading before the source. The original
markdown image URL is preserved. Request-count tests cover Chromium and WebKit.

Diagrams never fetch remote images. Before Mermaid lays out in the live DOM,
shape attributes are parsed with bounded, alias-free YAML so quoted/escaped
image keys cannot bypass replacement. Resource-bearing HTML and escaped CSS
style commands are removed; the label sanitizer forbids resource tags and
style/source attributes. Diagram directives cannot replace that sanitizer or
inject theme CSS/font settings. The returned SVG is checked again for external
resource references. These controls precede the CSP change: only `img-src`
gains `https:`; HTTP, connection, media and navigation policies stay bounded.

### Pull requests (D16, M69.11)

Opening a page with a GitHub PR link can run the person's own `gh` against
GitHub using its existing login. Cerebro does not read a token. Only a validated,
canonical `https://github.com/owner/repo/pull/number` reaches the one command:
`gh pr view <url> --json <fixed fields>`. Credentials, ports, encoded paths,
other hosts and non-PR routes never reach argv. The response URL and number
must describe the requested PR. This read is available to the human page only;
it is not an agent tool and writes no vault, runtime or diagnostic record.

The process starts in the system temporary directory, with repository/host
overrides removed and prompts, paging, color and update checks disabled. Its
stdout is capped at 2 MiB, its stderr tail is bounded by the shared supervisor,
and its 15-second deadline ends and reaps the process group. A nonblocking
reader also exits when a descendant keeps stdout open. At most two reads run,
and concurrent requests for the same canonical link share one child. Successful
reads are reused for 60 seconds and failures for 10; expired entries are removed
on access. Memory caching is limited to 64 entries and 16 MiB of serialized
results. A rollup above 10,000 checks is unreadable. Unknown or missing status
information remains unknown, never a successful check.

The command and environment contract follows the official
[PR view](https://cli.github.com/manual/gh_pr_view) and
[environment](https://cli.github.com/manual/gh_help_environment) documentation.
Tests invoke generated toy scripts only; they never authenticate, inspect a
real PR or modify the person's GitHub session.

### Mail is drafted, never sent (D15)

Cerebro has no mail-sending MCP tool. Every run holding a configured connector
adds the shared tool manifest's `never_call` names on each loaded server to its
one CLI deny flag. Names are ASCII-only and source-attributed; server names
pass the existing CLI normalization and collision checks. Record and skill
allows cannot remove these denials, including on unattended runs. The shared
server instructions also tell every run to leave a draft for the person to
review and send.

This is an exact-name boundary, not a claim that arbitrary connectors are safe.
A third-party server can expose another spelling or a general execution tool;
those are outside this inventory. Legacy attended runs that inherit global CLI
connectors without a vault connector list do not disclose their server names to
Cerebro, so this argv join cannot bind them. A shell-granted run can also reach
external services through its shell. Use configured, approved connectors and
least privilege; the prompt alone is not the boundary. The owner still owes the
isolated toy-server check proving the pinned CLI hides denied send tools while
leaving draft creation available. No test sends mail or calls an owner's account.

Foreign transcript calls show the CLI server spelling and a connector chip;
they are never styled as vault changes and offer no vault diff. The structured
native imports remain their own local write cards.

The editable `/draft-reply` recipe narrows an attended turn to Gmail and the
declared thread/draft tools, plus two read-only vault tools. A skill's connector
names intersect with an addressed agent's; denials union. These restrictions
are copied before asynchronous work and frozen in queued turns. The recipe
treats thread text as untrusted, asks when identity or recipients are unclear,
limits recipients to the thread, omits bcc, attachments and HTML, and keeps the
signature on its skill page. A placeholder signature is omitted and named in
the reply. It writes no vault file. The scripted browser proof uses only
example.com addresses; a real signed-in draft and Gmail's own signature behavior
still need the owner's isolated check. No test uses a live mail account.
