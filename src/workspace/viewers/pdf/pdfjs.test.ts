import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ getDocument: vi.fn(), viewer: vi.fn(), scripting: false }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  PDFWorker: class {
    promise = Promise.resolve();
    destroy() {}
  },
  getDocument: mock.getDocument,
  AnnotationType: { LINK: 2 },
  AnnotationMode: { ENABLE: 1 },
  AnnotationEditorType: { DISABLE: -1 },
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: '/worker.mjs' }));
vi.mock('pdfjs-dist/legacy/web/pdf_viewer.css', () => ({}));
vi.mock('pdfjs-dist/legacy/web/pdf_viewer.mjs', () => ({
  EventBus: class {
    on() {}
    dispatch() {}
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
    goToPage() {}
  },
  PDFFindController: class {
    setDocument() {}
  },
  PDFViewer: class {
    constructor(options: unknown) {
      mock.viewer(options);
    }
    get enableScripting() {
      return mock.scripting;
    }
    setDocument() {}
  },
}));
let ports: EventTarget[] = [];
beforeEach(() => {
  ports = [];
  vi.resetModules();
  vi.clearAllMocks();
  mock.scripting = false;
  vi.stubGlobal(
    'Worker',
    class extends EventTarget {
      constructor() {
        super();
        ports.push(this);
      }
      terminate() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it('opens inert bytes and filters annotations before any non-link widget can render', async () => {
  const annotations = vi.fn(async () => [
    { annotationType: 2, url: 'https://example.test' },
    { annotationType: 2, attachment: { filename: 'embedded.txt' } },
    { annotationType: 1 },
    { annotationType: 20 },
  ]);
  const doc = { getPage: async () => ({ getAnnotations: annotations }) };
  mock.getDocument.mockReturnValue({ promise: Promise.resolve(doc), destroy: vi.fn() });
  const { openPdf, mountPdfView } = await import('./pdfjs');
  const opened = await openPdf(new Uint8Array([1, 2]));
  expect(opened.ok).toBe(true);
  expect(mock.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      enableXfa: false,
      useWasm: false,
      cMapUrl: '/pdfjs/cmaps/',
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    }),
  );
  if (!opened.ok) return;
  expect(await (await opened.doc.getPage(1)).getAnnotations()).toEqual([
    { annotationType: 2, url: 'https://example.test' },
  ]);
  const handle = await mountPdfView(document.createElement('div'), opened.doc, {
    page() {},
    scale() {},
    matches() {},
    failed() {},
  });
  const options = mock.viewer.mock.calls[0][0];
  expect(options).not.toHaveProperty('scriptingManager');
  expect(options).toMatchObject({
    annotationMode: 1,
    annotationEditorMode: -1,
    enableAutoLinking: false,
  });
  handle.destroy();
  mock.scripting = true;
  await expect(
    mountPdfView(document.createElement('div'), opened.doc, {
      page() {},
      scale() {},
      matches() {},
      failed() {},
    }),
  ).rejects.toThrow('scripting must remain disabled');
});
it('a worker load failure is an engine refusal, never an indefinitely loading document', async () => {
  mock.getDocument.mockReturnValue({
    promise: new Promise(() => {}),
    destroy: vi.fn(async () => {}),
  });
  const { loadPdfEngine, openPdf } = await import('./pdfjs');
  await loadPdfEngine();
  const pending = openPdf(new Uint8Array([1]));
  ports[0].dispatchEvent(new Event('error'));
  expect(await pending).toEqual({ ok: false, reason: 'engine' });
});
