// Pure closed contract shared by generation, source-only tests and root output inspection.
export const QUIT_ENTRY_FILE = 'quit.js';
export const QUIT_ENTRY_EXPORT = 'mountQuitFixture';
export const QUIT_ENTRY_SIGNATURES = 'strict';
export function assertQuitEntryChunk(chunk, expectedFacade) {
  if (
    !chunk ||
    chunk.type !== 'chunk' ||
    chunk.fileName !== QUIT_ENTRY_FILE ||
    chunk.isEntry !== true ||
    chunk.facadeModuleId !== expectedFacade ||
    !Array.isArray(chunk.exports) ||
    !chunk.exports.includes(QUIT_ENTRY_EXPORT)
  ) {
    throw new Error('Generated quit entry must retain its named mount export');
  }
}
export function assertQuitEntryAst(ast) {
  if (!ast || ast.type !== 'Program' || !Array.isArray(ast.body)) {
    throw new Error('Generated quit entry must be a parsed ES module');
  }
  const named = (name) => name?.name === QUIT_ENTRY_EXPORT || name?.value === QUIT_ENTRY_EXPORT;
  const retained = ast.body.some(
    (node) =>
      node.type === 'ExportNamedDeclaration' &&
      node.source == null &&
      (named(node.declaration?.id) ||
        node.specifiers?.some((specifier) => named(specifier.exported))),
  );
  if (!retained) throw new Error('Generated quit bytes lack the named mount export');
}

// Output paths stay in the embedded fixture directory. WASM must be a hashed asset;
// the builder additionally joins its bytes to a pinned canonical local input.
export function assertQuitAsset(name, type, byteLength) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > 4 * 1024 * 1024 ||
    (type !== 'chunk' && type !== 'asset')
  ) {
    throw new Error('Asset path/bound');
  }
  if (type === 'asset' && /^quit-[A-Za-z0-9_-]+[.]wasm$/.test(name)) return 'wasm';
  if (type === 'asset' && /^quit-[A-Za-z0-9_-]+[.]ttf$/.test(name)) return 'font';
  if (/^quit(?:[-.][A-Za-z0-9_-]+)*\.(js|css)$/.test(name)) return 'script-or-style';
  throw new Error('Asset path/bound');
}
