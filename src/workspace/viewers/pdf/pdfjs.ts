/**
 * The only PDF.js importer (CV-14). Upstream legacy 5.7.284 targets Safari16.4,
 * covering macOS14's WebKit17; 6.x raises that floor to18. No fork or shim.
 * No scripting manager/sandbox is imported (GHSA-hq66-cqwq-w95j mitigation).
 * Upstream removed isEvalSupported before this version: there is no document
 * eval path to enable. Strict script CSP remains a second boundary.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { findRequest, type PdfMatches } from './find';
import { clampZoom, type PdfScale } from './zoom';

export type PdfDocument = PDFDocumentProxy;
export type PdfOpen =
  { ok: true; doc: PdfDocument } | { ok: false; reason: 'encrypted' | 'corrupt' | 'engine' };
type Engine = Awaited<ReturnType<typeof makeEngine>>;
let engine: Promise<Engine> | null = null;
class PdfEngineError extends Error {}

async function makeEngine() {
  const library = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let port: Worker | undefined;
  if (typeof window === 'undefined') {
    // Upstream's Node fake-worker entry; real document tests never need a DOM.
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  } else {
    const { default: url } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url');
    port = new Worker(url, { type: 'module' });
  }
  // Upstream's generated declaration infers port:null although its public
  // constructor accepts a Worker (the implementation calls port.postMessage).
  const WorkerClass = library.PDFWorker as unknown as new (options: {
    port?: Worker;
  }) => InstanceType<typeof library.PDFWorker>;
  const worker = new WorkerClass({ port });
  const failed = new Promise<never>((_resolve, reject) => {
    const fail = () => {
      port?.terminate();
      worker.destroy();
      reject(new PdfEngineError('The PDF worker could not run'));
    };
    port?.addEventListener('error', fail, { once: true });
    port?.addEventListener('messageerror', fail, { once: true });
  });
  // A shared worker can fail while no document is opening. Future opens still
  // race the rejected promise; avoid a second, unhandled-rejection report.
  void failed.catch(() => undefined);
  try {
    await worker.promise;
  } catch (error) {
    port?.terminate();
    worker.destroy();
    throw error;
  }
  return { library, worker, failed };
}

/** Cached once; importing this module starts no worker and loads no renderer. */
export function loadPdfEngine(): Promise<Engine> {
  return (engine ??= makeEngine());
}

export async function openPdf(bytes: Uint8Array): Promise<PdfOpen> {
  let loaded: Engine;
  try {
    loaded = await loadPdfEngine();
  } catch {
    return { ok: false, reason: 'engine' };
  }
  const task = loaded.library.getDocument({
    data: bytes.slice(),
    worker: loaded.worker,
    enableXfa: false,
    useWasm: false,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    // Text-only Node tests have no fetchable origin. Browser assets stay same-origin.
    useWorkerFetch: typeof window !== 'undefined',
  });
  try {
    const doc = await Promise.race([task.promise, loaded.failed]);
    // Filter at the public page API before annotation rendering: no attachment,
    // form, comment or other annotation widget is ever constructed. Internal and
    // external links still use PDFLinkService, with no scripting manager.
    const getPage = doc.getPage.bind(doc);
    const filtered = new WeakSet<object>();
    doc.getPage = async (number) => {
      const page = await getPage(number);
      if (!filtered.has(page)) {
        filtered.add(page);
        const annotations = page.getAnnotations.bind(page);
        page.getAnnotations = async (options) =>
          (await annotations(options)).filter(
            (annotation: { annotationType: number; attachment?: unknown }) =>
              annotation.annotationType === loaded.library.AnnotationType.LINK &&
              !annotation.attachment,
          );
      }
      return page;
    };
    return { ok: true, doc };
  } catch (error) {
    if (error instanceof PdfEngineError) {
      // A dead worker cannot answer a destroy handshake.
      void task.destroy().catch(() => undefined);
      return { ok: false, reason: 'engine' };
    }
    await task.destroy();
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === 'PasswordException' ? 'encrypted' : 'corrupt',
    };
  }
}

/** A failed sample is unavailable, not a claim that the document has no text. */
export async function hasTextLayer(
  doc: Pick<PdfDocument, 'numPages' | 'getPage'>,
): Promise<boolean> {
  const pages = [...new Set([1, Math.ceil(doc.numPages / 2), doc.numPages])];
  for (const number of pages) {
    const content = await (await doc.getPage(number)).getTextContent();
    if (content.items.some((item) => 'str' in item && item.str.trim().length > 0)) return true;
  }
  return false;
}

export interface PdfViewEvents {
  page(number: number): void;
  scale(value: number): void;
  matches(value: PdfMatches): void;
  failed(number: number): void;
}
export interface PdfView {
  page(number: number): void;
  scale(value: PdfScale): void;
  find(query: string, again?: boolean, previous?: boolean): void;
  closeFind(): void;
  destroy(): void;
}
export async function mountPdfView(
  container: HTMLDivElement,
  doc: PdfDocument,
  events: PdfViewEvents,
): Promise<PdfView> {
  const { library } = await loadPdfEngine();
  const [{ EventBus, PDFLinkService, PDFFindController, PDFViewer }] = await Promise.all([
    import('pdfjs-dist/legacy/web/pdf_viewer.mjs'),
    import('pdfjs-dist/legacy/web/pdf_viewer.css'),
  ]);
  const abort = new AbortController();
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: 2,
    externalLinkRel: 'noopener noreferrer',
    ignoreDestinationZoom: true,
  });
  const findController = new PDFFindController({ eventBus, linkService });
  const options = {
    container,
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    annotationMode: library.AnnotationMode.ENABLE,
    annotationEditorMode: library.AnnotationEditorType.DISABLE,
    enableAutoLinking: false,
    abortSignal: abort.signal,
  };
  const viewer = new PDFViewer(options);
  // A future upstream default must not silently enable PDF scripts.
  if (viewer.enableScripting) {
    abort.abort();
    throw new Error('PDF scripting must remain disabled');
  }
  eventBus.on('pagesinit', () => {
    viewer.currentScaleValue = 'page-width';
  });
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => events.page(pageNumber));
  eventBus.on('scalechanging', ({ scale }: { scale: number }) => events.scale(scale));
  eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: PdfMatches }) =>
    events.matches(matchesCount),
  );
  eventBus.on('updatefindcontrolstate', ({ matchesCount }: { matchesCount: PdfMatches }) =>
    events.matches(matchesCount),
  );
  eventBus.on('pagerendered', ({ pageNumber, error }: { pageNumber: number; error?: unknown }) => {
    if (error) events.failed(pageNumber);
  });
  linkService.setViewer(viewer);
  linkService.setDocument(doc);
  viewer.setDocument(doc);
  let destroyed = false;
  return {
    page: (number) => {
      linkService.goToPage(Math.max(1, Math.min(doc.numPages, number)));
    },
    scale: (value) => {
      viewer.currentScaleValue = typeof value === 'number' ? String(clampZoom(value)) : value;
    },
    find: (query, again, previous) => {
      if (!again) viewer.currentPageNumber = 1;
      eventBus.dispatch('find', { source: viewer, ...findRequest(query, again, previous) });
    },
    closeFind: () => eventBus.dispatch('findbarclose', { source: viewer }),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      (viewer.setDocument as (doc: PdfDocument | null) => void)(null);
      linkService.setDocument(null);
      (findController.setDocument as (doc: PdfDocument | null) => void)(null);
      abort.abort();
      container.replaceChildren();
    },
  };
}
