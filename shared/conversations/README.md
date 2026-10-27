# Conversation archive transport

Rust owns the checked display carrier in `src-tauri/src/runtime/conversations.rs`.
The display question is frozen before prompt assembly. These IDs select display
records and grant no run, credential, effect or import authority. Required null
means recorded absence; missing or unknown authority fields are malformed.

`contracts.v1.json` is Rust/Schemars output, projected into TypeScript through the
existing contract generator. Root commands for explicit regeneration:

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib runtime::conversations::contract_tests::export_conversation_contract_schema -- --ignored --exact
pnpm exec node --import tsx scripts/contracts/generate.ts
```

Replay `conversation_contract_matches_rust_owned_transport`,
`conversation_display_transport_rejects_authority_and_missing_recorded_absence`
and `scripts/conversation-contract.test.ts`. No retention choice is enabled by
loading this contract or opening a vault. Archive admission remains Rust-owned.
