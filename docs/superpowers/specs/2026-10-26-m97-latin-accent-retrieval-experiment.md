# M97 — Latin accent retrieval experiment

**Phase:** M97.8. **Status:** the bounded experiment passed its local acceptance
gates on 2026-10-26. This is not an overall release-quality threshold.

The reviewed native baseline misses `cafe` against the explicitly relevant café
source. The selected experiment adds conservative Latin accent aliases to the
existing ranker, using the already installed Unicode normalization dependency.
It does not add a corpus, cache, index or external service.

The candidate keeps the existing exact-token results first, in their original
order. It may append previously unmatched documents whose precomposed Latin
letters canonically decompose to an ASCII letter plus combining marks. It keeps
Greek accents, Japanese voicing and other non-Latin distinctions. Transliteration,
stemming, paraphrase matching and complete decomposed-word normalization are
outside this experiment. In particular, the existing tokenizer's treatment of a
combining mark inside a decomposed word remains a documented limitation.

Ranking reads the same already scoped and capped documents. Folded tokens are
transient query work; original Markdown, source snapshot hashes, UTF-8 ranges,
excerpt text and displayed query terms stay intact. Existing query, body and
result caps remain unchanged. No permissions or stored content change.

Acceptance requires the seven direct ranker cases, existing search/location/native
scope regressions and all twelve labeled native queries. The accent query must
find its eligible source, with no lost previously found source, new scope leak,
incorrect offset or exact-result reordering. Three disposable native captures
before and after will compare the median total query time over the same corpus;
a regression above 25% rejects this small experiment. These observations are
local comparisons, not a p95 desktop performance claim. Missing model quality,
cost or memory measurements remain unmeasured.

The candidate will be removed if its benefit fails those gates; the baseline,
failed attempts and comparison remain in the research record. Paraphrase,
beyond-body-cap and result-cutoff misses remain separate measured limitations.

## Measured result — 2026-10-26

The same twelve labeled native queries ran three times before and three times
after the change against disposable synthetic content. The accent query changed
from no result to its one eligible source. All previously returned sources kept
their order; no query gained a scope leak. Paraphrase and beyond-body-cap queries
still miss, and the cutoff query still returns 20 of 25 eligible sources.

| Measurement | Before | After |
| --- | --- | --- |
| Total query time, three captures (ms) | 871.36, 881.34, 946.28 | 909.28, 920.20, 890.95 |
| Median total query time (ms) | 881.34 | 909.28 |
| Accent source retrieved | 0 of 1 | 1 of 1 |
| Scope leaks across twelve queries | 0 | 0 |

The median increase is **3.17%**, below the predeclared 25% rejection limit.
All 53 search cases (including seven accent cases), four source-location cases,
six native retrieval controls and 115 outcome/retrieval harness cases pass in
their recorded focused replays. The original regression run retained one passing
control and five missing-accent failures; the later query-OR review added the
seventh case. No correctness gate was relaxed to accept the experiment.

The captures retain their exact producer source and binary identities locally;
the before and after comparisons were evaluated against their matching source
inventories. OS caches were not reset. These are local total-query comparisons,
not desktop p95, live model, cost, answer-support or memory measurements. The
source-location and scope limits above remain in effect.
