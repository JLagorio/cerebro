# `shared/prompt/` — prose the model reads (M54.7)

Text cerebro hands the model, kept in one place so Rust and TypeScript hand
it the same bytes. Rust compiles each file in with `include_str!`; TS imports
it through vite's `?raw`, which vitest reads too. `retired-terms.json` is the
one file no run reads: it lists what the others may not say, for the tests.

| File | What it is |
| --- | --- |
| `server-instructions.md` | The MCP `instructions` the loopback serves in its `initialize` answer (`src-tauri/src/mcp.rs`, `initialize_result`), trimmed, to every bearer alike: the panel, a skill turn, an agent run, a `hand_to` callee, the ingest, maintain and assembly runs, and the editor's two runs. `src/agent/systemPrompt.ts` reads its bullets too, for the fallback its `SERVER_RULES_IN_PROMPT` switch describes. |
| `product-brief.md` | What cerebro is, said once (M54.8): the only description of the product the model reads. The system prompt opens with it for every grant (`src/agent/systemPrompt.ts`, through `src/lib/productBrief.ts`), and `get_vault_context` ends with it under "About this app:" (`PRODUCT_BRIEF` in `src-tauri/src/mcp.rs`). Both trim it, so the file ends in exactly one newline. It holds for every grant, yet rides the system prompt rather than the server instructions: that prompt is sent fresh every turn, so a resumed turn hears it whatever M54.7's live check finds. It never mentions the knowledge bundle: only runs that declare `knowledge` hear about it (M34.1.3). When the app changes what a page is or how one opens, this is the one place to say so. |
| `subagent-line.md` | What every subagent of a run hears beside the brief and the server instructions (M91.2b): it works for the main assistant, can't ask the person anything or continue later, and reports what it found by page and link. Rust composes `--append-subagent-system-prompt` from `product-brief.md`, `server-instructions.md` and this file, each trimmed, in that order (`subagent_brief` in `src-tauri/src/agent/cli_agents.rs`), on every run that holds Claude Code's subagent tool; no prose is copied into code. |
| `subagents/researcher.md` | The standing prompt of `cerebro-researcher`, the one agent type Cerebro defines (M91.2b, `shared/policy/subagents.v1.json`'s preset): it gathers from the vault, and the web where its run holds it, and changes nothing. Rust hands it, trimmed, as the preset's `prompt` in the run's `--agents` definition (`src-tauri/src/agent/cli_agents.rs`); the tools it may call are the definition's, never the prompt's. |
| `retired-terms.json` | Words for the model cerebro retired (M54.8). None may appear in the brief, the server instructions, a prompt, the mock's overview reply, the tool manifest, `get_vault_context` or the welcome screen. Each term matches as a case-insensitive substring, in `src/lib/productBrief.test.ts`, `src/App.test.tsx` and mcp.rs's `get_vault_context_speaks_the_current_model`. A term that retires joins the list. A substring also catches innocent copy ("framework items" holds "work item"); reword the copy, never trim the list. AGENTS.md's CV-20 is the rule. |

## The rules for these files

- **They name no cerebro tool.** What a run may call depends on its grant, and
  the server instructions and the brief go to every run. A sentence that
  names a tool belongs in a typed prompt fragment that declares it
  (`src/agent/systemPrompt.ts`, `src/lib/prompts.ts`), composed against the
  run's grant (`src/engine/toolGrant.ts`). AGENTS.md's CV-19 is the rule, and
  `the_server_instructions_name_no_tool` in mcp.rs,
  `src/agent/promptGrant.test.ts` and `src/lib/productBrief.test.ts` hold it.
  The subagent prose (`subagent-line.md`, `subagents/`) names no Claude Code
  tool either (M91.2b): a subagent's tools are its definition's, narrowed to
  its run's grant, so a name there could promise one it lacks.
  `cli_agents.rs`'s tests and the two TS files above scan it, and the
  composed subagent text, for both.
- **The server instructions are grant-invariant.** `initialize_result` takes
  no grant, so nothing can vary them by run. The CLI delivers `instructions`
  as a session meta message, which a resumed session (`--resume`) is expected
  to keep; M54.7's live check on CLI 2.1.250 settles that, and
  `SERVER_RULES_IN_PROMPT` is the fallback if it does not.
  `--append-system-prompt` is sent fresh every turn, so text that follows the
  grant rides there.
- **At most 2048 UTF-16 units**, the most the CLI keeps of a server's
  instructions. `the_server_instructions_fit_the_clis_cap` holds it. The brief
  stays at most 1500 characters, because it rides every turn's system prompt
  and every `get_vault_context` answer; `src/lib/productBrief.test.ts` holds
  that.
- **No digest**, as with `shared/policy/links.v1.json`: Rust and TS compile
  the same file, so there are no second bytes to drift from. The folder is
  `.prettierignore`d all the same, because a reflow would change what every
  run is told.
- **Never built from vault files.** The vault is user content, and the CLI
  loads none of it as configuration (M17.1, `--setting-sources user`); a
  vault file that could edit these would be a prompt injection with the
  app's voice.
