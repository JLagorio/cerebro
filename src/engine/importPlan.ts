import { parseDocument } from 'yaml';
import { splitFrontmatter } from './frontmatter';
import {
  canonicalRecordId,
  composeImport,
  importPathRefusal,
  importWords,
  storedImportHash,
  storedRecordId,
  type ImportStamp,
} from './importSources';
import { sha256Hex } from '@/lib/sha256';

export interface ImportBatchOp {
  op: 'import';
  system: string;
  recordId: string;
  url?: string;
  path: string;
  content: string;
}
export interface ImportResult {
  index: number;
  system: string;
  recordId: string;
  outcome: 'created' | 'replaced' | 'unchanged' | 'kept' | 'duplicate';
  path: string;
  alsoAt: string[];
  reason: 'changed_since_import' | 'stamp_unreadable' | null;
  first: number | null;
}
export interface ImportFile {
  path: string;
  content: string;
}
type PlannedWrite =
  | { op: 'create'; path: string; content: string }
  | { op: 'replace_file'; path: string; content: string; expectHash: string };
const lower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const keyOf = (system: string, id: string) => JSON.stringify([system, id]);
/** Unicode scalar order matches Rust's UTF-8 path order, without locale rules. */
const pathOrder = (a: ImportFile, b: ImportFile) => {
  const x = [...a.path],
    y = [...b.path];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const delta = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (delta) return delta;
  }
  return x.length - y.length;
};
export function copyIndexOf(files: readonly ImportFile[]): Map<string, ImportFile[]> {
  const result = new Map<string, ImportFile[]>();
  for (const file of [...files].sort(pathOrder)) {
    if (importPathRefusal(file.path) !== null) continue;
    try {
      const yaml = splitFrontmatter(file.content).yaml;
      if (yaml === null) continue;
      const parsed = parseDocument(yaml);
      if (parsed.errors.length) continue;
      const fields: unknown = parsed.toJS({ maxAliasCount: 100 });
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) continue;
      const { source_system: system, source_record_id: raw } = fields as Record<string, unknown>;
      if (typeof system !== 'string' || typeof raw !== 'string') continue;
      const id = storedRecordId(system, raw);
      if (id === null) continue;
      const key = keyOf(system, id);
      const copies = result.get(key) ?? [];
      copies.push(file);
      result.set(key, copies);
    } catch {
      /* A malformed page is occupied, but not a readable import identity. */
    }
  }
  return result;
}
/** Plan every import before the batch writer touches any page. */
export function planImports(
  requests: readonly { index: number; op: ImportBatchOp }[],
  files: readonly ImportFile[],
  occupied: readonly string[],
  otherPaths: readonly string[],
  stamp: Pick<ImportStamp, 'now' | 'actor' | 'method'>,
): { writes: { index: number; op: PlannedWrite }[]; imports: ImportResult[] } {
  const copies = copyIndexOf(files);
  const held = new Set([...occupied, ...files.map((file) => file.path)].map(lower));
  const other = new Set(otherPaths.map(lower));
  const seen = new Map<string, ImportResult>();
  const writes: { index: number; op: PlannedWrite }[] = [];
  const imports: ImportResult[] = [];
  for (const { index, op } of requests) {
    const recordId = canonicalRecordId(op.system, op.recordId);
    const invalid = importPathRefusal(op.path);
    if (invalid !== null) throw new Error(invalid);
    // Even a duplicate's payload must be valid: one bad op refuses the batch.
    const composed = composeImport(op.content, {
      system: op.system,
      recordId,
      url: op.url,
      ...stamp,
    });
    const key = keyOf(op.system, recordId);
    const first = seen.get(key);
    if (first !== undefined) {
      imports.push({ ...first, index, outcome: 'duplicate', first: first.index, reason: null });
      continue;
    }
    const found = copies.get(key) ?? [];
    const old = found[0];
    let path = old?.path ?? op.path;
    let outcome: ImportResult['outcome'];
    let reason: ImportResult['reason'] = null;
    if (old !== undefined) {
      if (other.has(lower(path))) throw new Error(importWords('path_twice', { path }));
      const hash = storedImportHash(old.content);
      if (hash === null) {
        outcome = 'kept';
        reason = 'stamp_unreadable';
      } else if (hash.current !== hash.stored) {
        outcome = 'kept';
        reason = 'changed_since_import';
      } else if (hash.stored === composed.hash) outcome = 'unchanged';
      else {
        outcome = 'replaced';
        writes.push({
          index,
          op: {
            op: 'replace_file',
            path,
            content: composed.content,
            expectHash: sha256Hex(old.content),
          },
        });
      }
    } else {
      if (other.has(lower(path))) throw new Error(importWords('path_twice', { path }));
      const dot = op.path.lastIndexOf('.');
      const stem = op.path.slice(0, dot);
      const ext = op.path.slice(dot);
      for (let suffix = 2; held.has(lower(path)); suffix += 1) path = `${stem}-${suffix}${ext}`;
      if (other.has(lower(path))) throw new Error(importWords('path_twice', { path }));
      outcome = 'created';
      held.add(lower(path));
      writes.push({ index, op: { op: 'create', path, content: composed.content } });
    }
    const result: ImportResult = {
      index,
      system: op.system,
      recordId,
      outcome,
      path,
      alsoAt: found.slice(1).map((file) => file.path),
      reason,
      first: null,
    };
    imports.push(result);
    seen.set(key, result);
  }
  return { writes, imports };
}
