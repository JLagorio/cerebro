/** Copy first, then file a provenance-carrying document capture. No original is edited. */
import { attachmentRefusal } from '@/engine/attachments';
import { kindFor } from '@/engine/fileKinds';
import { filedCopyOf } from '@/engine/ingest';
import { INBOX_DIR } from '@/engine/inbox';
import { extractionNote, toExtractedDoc, type Extraction } from '@/engine/extracted';
import { useVaultStore } from '@/stores/vaultStore';
import { captureSlug } from './capture';
import { extractDocument, importAttachment, importAttachmentBytes } from './ipc';
import { readFileBytes } from './rootsIpc';
import { extractPdfText } from './extract/pdfText';
import { sha256Bytes } from './sha256';
import { VAULT_STILL_OPENING, type IngestOutcome, type SeenInDrop } from './ingest';
export type DocumentSource = File | { path: string; name: string };
const jobs = new Map<string, Promise<void>>();
async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.readAsArrayBuffer(file);
  });
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
interface DocumentResult {
  outcome: IngestOutcome;
  note: string | null;
}
/** One vault's capture jobs take turns: concurrent drops cannot both decide
 * that the same hash is new before either createItem refreshes the corpus. */
export async function ingestDocument(
  source: DocumentSource,
  current: () => boolean,
  seen: SeenInDrop,
): Promise<DocumentResult | null> {
  const vault = useVaultStore.getState().vaultPath;
  if (vault === null) throw new Error('Open a vault before adding documents.');
  // A→B→A is still a different visit. Retire queued work synchronously at
  // the first switch, including callers that supplied no component lifetime.
  let retired = false;
  const unsubscribe = useVaultStore.subscribe((state) => {
    if (state.vaultPath !== vault) retired = true;
  });
  const previous = jobs.get(vault) ?? Promise.resolve();
  const result = previous.then(() => ingest(source, vault, () => !retired && current(), seen));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  jobs.set(vault, tail);
  try {
    return await result;
  } finally {
    unsubscribe();
    if (jobs.get(vault) === tail) jobs.delete(vault);
  }
}
async function ingest(
  source: DocumentSource,
  vault: string,
  current: () => boolean,
  seen: SeenInDrop,
): Promise<DocumentResult | null> {
  const active = () => current() && useVaultStore.getState().vaultPath === vault;
  const duplicate = (hash: string): IngestOutcome | null => {
    const store = useVaultStore.getState();
    if (store.vaultPath !== vault || store.entriesVault !== vault)
      throw new Error(VAULT_STILL_OPENING);
    const copy = seen.get(hash) ?? filedCopyOf(store.entries, hash);
    return copy === null || copy === undefined
      ? null
      : { kind: 'duplicate', path: copy.path, title: copy.title };
  };
  if (!active()) return null;
  if (useVaultStore.getState().entriesVault !== vault) throw new Error(VAULT_STILL_OPENING);
  let bytes: Uint8Array | null = null;
  if (!('path' in source)) {
    const refusal = attachmentRefusal(source.name, source.size);
    if (refusal !== null) throw new Error(refusal);
    bytes = await fileBytes(source);
    if (!active()) return null;
    const copy = duplicate(sha256Bytes(bytes));
    if (copy) return { outcome: copy, note: null };
  }
  const kept =
    'path' in source
      ? await importAttachment(vault, source.path)
      : await importAttachmentBytes(vault, source.name, base64(bytes!));
  if (!active()) return null;
  let extraction: Extraction;
  if (kindFor(source.name).extractor === 'pdf') {
    if (bytes === null) {
      const read = await readFileBytes('0', kept.path);
      if (!active()) return null;
      if (!(read instanceof Uint8Array)) throw new Error(read.message);
      bytes = read;
    }
    const sha256 = sha256Bytes(bytes);
    const copy = duplicate(sha256);
    if (copy) return { outcome: copy, note: null };
    extraction = {
      format: 'pdf',
      sha256,
      bytes: bytes.byteLength,
      outcome: await extractPdfText(bytes),
    };
  } else extraction = await extractDocument(vault, kept.path);
  if (!active()) return null;
  const copy = duplicate(extraction.sha256);
  if (copy) return { outcome: copy, note: null };
  const doc = toExtractedDoc({
    filename: source.name,
    attachment: kept.path,
    extraction,
    at: new Date().toISOString(),
  });
  const path = await useVaultStore.getState().createItem({
    folder: INBOX_DIR,
    slug: captureSlug(doc.title),
    frontmatter: doc.frontmatter,
    body: doc.body,
  });
  if (!active()) return null;
  seen.set(extraction.sha256, { path, title: doc.title });
  return { outcome: { kind: 'filed', path }, note: extractionNote(extraction.outcome) };
}
