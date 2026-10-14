/**
 * What cerebro is, said once (M54.8): the one description of the product the
 * model reads. The system prompt opens with it for every grant
 * (src/agent/systemPrompt.ts), and get_vault_context ends with the same bytes,
 * which the Rust core compiles in as `PRODUCT_BRIEF` in src-tauri/src/mcp.rs.
 * shared/prompt/README.md holds the file's rules: it names no tool, never
 * mentions the knowledge bundle, and says no term
 * shared/prompt/retired-terms.json lists.
 */
import brief from '../../shared/prompt/product-brief.md?raw';

export const PRODUCT_BRIEF = brief.trim();
