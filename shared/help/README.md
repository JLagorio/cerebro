# Product help

The five Markdown guides are the human source. `catalog.v1.json` selects only
these local files and declares any referenced Cerebro tools. `build-help.ts`
checks the shipped tool manifest, retired vocabulary and the 16 KiB encoded
topic limit, then stamps the app version and SHA-256 of the exact guide bytes.

Regenerate after guide or package-version changes:

```sh
pnpm exec node --import tsx scripts/build-help.ts
pnpm exec node --import tsx scripts/build-help.ts --check
pnpm exec vitest run scripts/help.test.ts src/app/ProductHelp.test.tsx
```

The app retrieves one topic at a time under Settings → About → Product help.
The generated catalog contains no vault text, credentials or memory. It is not
injected into prompts. A future agent-facing retrieval tool belongs to M96's
manifest and policy review. `shared/prompt/product-brief.md` remains the product
description; these guides explain individual tasks.
