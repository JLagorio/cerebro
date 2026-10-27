# M97.7 — Retrieval label review

Reviewed 2026-10-26 by Codex `/root/m95_generation_admission`, independently of
the original fixture author. Root reviewed the judgments against the literal
synthetic corpus and queries and verified every quoted passage occurs exactly
once in its named source. This is agent review, not owner approval.

All 37 judgments in `conformance/retrieval/labels.json` are accepted for **source
relevance**. The corpus, queries, passages and supporting/counterevidence roles
are unchanged. The evaluator does not measure factual reliability, answer
support or model abstention; accepting a relevant source certifies none of those.

| Query family | Review basis and limits |
| --- | --- |
| Exact budget | The named Harbor budget appears explicitly. |
| Paraphrase | A completion deadline is a potentially useful source for “When will we finish?”; the query supplies no project identity, so this is not a uniquely established answer. |
| Alias | Lantern appears as the display alias of the project wikilink. |
| Accent | Café is relevant to cafe; retrieval normalization has not been assumed. |
| Multilingual | The Japanese shipping-schedule terms appear in the source. |
| Long source | The requested marker is present beyond the production body cap. Relevance does not mean the retriever can see the passage. |
| Imported shape | Harbor permits and their review prerequisite appear explicitly. The synthetic import-shaped record proves no importer behavior. |
| Mixed record | The task names Mina and the roof inspection. |
| Counterevidence | The plan, explicit revision and undated rumor all concern the launch window. The revision contradicts the plan. The rumor's earlier dispute is resolved as source relevance; its reliability and the current date remain unadjudicated. |
| Scope | The private marker is semantically relevant but outside the allowed `visible` scope. It must stay outside the admitted denominator; returning it remains a hard scope failure. |
| Cutoff | All 25 distinct sources contain the marker, regardless of ranking or result limit. |
| Unanswerable | No passage answers “quantum bananas”; the empty label set is preserved. An empty retrieval is not evidence of model abstention. |

The provenance records the original author and independent reviewer. Existing
tests for excluding proposed, disputed and out-of-scope labels remain intact;
the shared fixture test now checks the reviewed state. The next evidence is a
fresh deterministic native retrieval capture and its scored report. No quality
target, live-model result or retention decision follows from this review.
