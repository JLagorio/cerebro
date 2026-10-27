# M97.7 — Reviewed retrieval baseline

The actual Rust `mcp::search_notes_in` producer ran all 12 synthetic queries on
2026-10-26. The six native fixture controls and all 115 outcome/retrieval harness
tests pass. The earlier harness run was 114 pass / 1 fail because its generated
source inventory omitted newly added files; explicit paired regeneration fixed
that mismatch. Labels were independently reviewed before scoring; see the
[label review](2026-10-26-m97-retrieval-label-review.md).

All queries passed the fixture scope gate with **zero out-of-scope hits**. That
status is not a search-quality threshold: the baseline exposes three complete
misses and the expected result-cap shortfall.

| Query | Relevant sources found / eligible | Elapsed ms |
| --- | --- | --- |
| Exact budget | 1 / 1 | 87.35 |
| Paraphrase | 0 / 1 | 76.44 |
| Wikilink alias | 1 / 1 | 69.66 |
| Accent variant | 0 / 1 | 71.02 |
| Japanese terms | 1 / 1 | 72.85 |
| Beyond body cap | 0 / 1 | 72.28 |
| Imported-shaped record | 1 / 1 | 73.13 |
| Task record | 1 / 1 | 72.16 |
| Launch counterevidence | 3 / 3, including 1 / 1 counterevidence | 70.15 |
| Unanswerable | Not applicable; no hits | 72.52 |
| Hidden source | Not applicable; hidden judgment excluded, no hits | 70.17 |
| Result cutoff | 20 / 25 at the production limit of 20 | 69.52 |

These are single observations over synthetic files, with a fresh in-process
corpus cache per query and OS caches left intact. They are not latency
percentiles or a scale acceptance result. The recorder checked fixture bytes
before and after each query. It did not instrument writes outside that fixture
tree. It invoked no model, credential store or external provider. Exact passage
display, answer support, model abstention and cost remain unmeasured; missing
cost is not zero.

The bounded normalization miss is the smallest justified next experiment under
M97.8. Its candidate must preserve exact-match priority and original UTF-8 byte
positions, keep the same corpus/scope/body/result caps, and improve the accent
case without losing any existing hit or revealing the hidden source. Paraphrase
requires a separate semantic hypothesis; the ambiguous query is not sufficient
grounds for an embedding store. The long-source and cutoff cases describe
existing caps and do not justify silently increasing them.

Reproduction evidence is local run `2026-10-26-finish/checks/rust-v28` under
`.superpowers/sdd/2026-10-23-m93-m99-master-roadmap/`. The capture was recorded at
`2026-10-26T17:01:36.635Z`, with 1,022 compiled input files, 24,491,238 input bytes
and aggregate input digest
`b823a76ccc209a1b45482f3f30eb1873793de4b977e4c5b1e187418d25772067`.
Label digest:
`7c11e2b0daab3a75a220cee330dd8c544f7eacd907b93a3f7b4b85a8835d1332`.
Raw capture and test logs remain ignored local evidence. This baseline does not
close live-model acceptance or select a completed-content retention policy.
