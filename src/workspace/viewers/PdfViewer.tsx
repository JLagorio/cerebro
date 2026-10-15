import { useEffect, useRef, useState } from 'react';
import { FILE_BYTES, isFileRefusal, type FileProbe } from '@/engine/fileBytes';
import { fileActionWords } from '@/engine/fileActions';
import { desktopFileActions, openFileOutside, readFileBytes } from '@/lib/rootsIpc';
import { useCommands, useKeyScope } from '@/lib/keys/useKeys';
import { useUiStore } from '@/stores/uiStore';
import { hasTextLayer, mountPdfView, openPdf, type PdfDocument, type PdfView } from './pdf/pdfjs';
import { toOutline, type OutlineItem } from './pdf/outline';
import { matchWords, type PdfMatches } from './pdf/find';
import { clampZoom, pageNumber, stepZoom, type PdfScale } from './pdf/zoom';
import './pdf/pdf.css';

type State =
  | { state: 'loading' }
  | { state: 'ready'; doc: PdfDocument }
  | { state: 'encrypted' | 'corrupt' | 'engine' | 'too-large' | 'unavailable' };
const WORDS = {
  loading: 'Opening PDF…',
  encrypted: 'This PDF needs a password. Open it in your PDF app or use Quick Look.',
  corrupt: 'This PDF could not be read. It may be damaged.',
  engine: 'The PDF viewer could not start. Open this file in your PDF app or use Quick Look.',
  'too-large': 'This PDF is over the 64 MiB preview limit.',
  unavailable: 'This PDF could not be read. Try opening it again.',
};

export function PdfViewer({
  rootId,
  path,
  probe,
}: {
  rootId: string;
  path: string;
  probe: FileProbe;
}) {
  const scope = useKeyScope('pdf-viewer');
  const [state, setState] = useState<State>({ state: 'loading' });
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [scale, setScale] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [outlineFailed, setOutlineFailed] = useState(false);
  const [text, setText] = useState<'checking' | 'yes' | 'no' | 'unavailable'>('checking');
  const [failed, setFailed] = useState<number[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PdfMatches>({ current: 0, total: 0 });
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<PdfView | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const ready = state.state === 'ready';
  const total = ready ? state.doc.numPages : 0;

  useEffect(() => {
    if (probe.size > FILE_BYTES.limits.body_bytes) {
      setState({ state: 'too-large' });
      return;
    }
    let live = true;
    let opened: PdfDocument | null = null;
    void (async () => {
      try {
        const bytes = await readFileBytes(rootId, path);
        if (!live) return;
        if (isFileRefusal(bytes)) {
          setState({ state: bytes.code === 'too_large' ? 'too-large' : 'unavailable' });
          return;
        }
        const result = await openPdf(bytes);
        if (result.ok) {
          opened = result.doc;
          if (!live) {
            await opened.destroy().catch(() => undefined);
            opened = null;
            return;
          }
          setState({ state: 'ready', doc: opened });
        } else if (live) setState({ state: result.reason });
      } catch {
        if (live) setState({ state: 'unavailable' });
      }
    })();
    return () => {
      live = false;
      // The page is already closed; a failed worker cleanup has no live UI to update.
      if (opened) void opened.destroy().catch(() => undefined);
    };
  }, [rootId, path, probe.size]);

  useEffect(() => {
    if (state.state !== 'ready' || !container.current) return;
    let live = true;
    const doc = state.doc;
    void mountPdfView(container.current, doc, {
      page: (number) => {
        if (live) {
          setPage(number);
          setPageDraft(String(number));
        }
      },
      scale: (value) => {
        if (live) setScale(value);
      },
      matches: (value) => {
        if (live) setMatches(value);
      },
      failed: (number) => {
        if (live) setFailed((rows) => [...new Set([...rows, number])].sort((a, b) => a - b));
      },
    })
      .then((handle) => {
        if (live) view.current = handle;
        else handle.destroy();
      })
      .catch(() => {
        if (live) setState({ state: 'engine' });
      });
    void toOutline(doc)
      .then((rows) => {
        if (live) setOutline(rows);
      })
      .catch(() => {
        if (live) setOutlineFailed(true);
      });
    void hasTextLayer(doc)
      .then((found) => {
        if (live) setText(found ? 'yes' : 'no');
      })
      .catch(() => {
        if (live) setText('unavailable');
      });
    return () => {
      live = false;
      view.current?.destroy();
      view.current = null;
    };
  }, [state]);

  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);
  const zoom = (value: PdfScale) => view.current?.scale(value);
  const find = (again = false, previous = false) => {
    if (query && text !== 'no') view.current?.find(query, again, previous);
  };
  const closeFind = () => {
    setFindOpen(false);
    view.current?.closeFind();
    container.current?.focus();
  };
  const jump = () => {
    const number = pageNumber(pageDraft, total);
    if (number !== null) {
      view.current?.page(number);
      setPageDraft(String(number));
    } else setPageDraft(String(page));
  };
  useCommands(
    [
      { id: 'pdf.outline', run: () => setOutlineOpen((value) => !value), when: () => ready },
      {
        id: 'pdf.page',
        run: () => {
          pageInput.current?.focus();
          pageInput.current?.select();
        },
        when: () => ready,
      },
      { id: 'pdf.zoomIn', run: () => zoom(stepZoom(scale, 1)), when: () => ready },
      { id: 'pdf.zoomOut', run: () => zoom(stepZoom(scale, -1)), when: () => ready },
      { id: 'pdf.actual', run: () => zoom(1), when: () => ready },
      { id: 'pdf.fit', run: () => zoom('page-width'), when: () => ready },
      {
        id: 'pdf.find',
        run: () => {
          setFindOpen(true);
          findInput.current?.focus();
        },
        when: () => ready,
      },
      { id: 'pdf.next', run: () => find(true), when: () => ready && findOpen && query.length > 0 },
      {
        id: 'pdf.previous',
        run: () => find(true, true),
        when: () => ready && findOpen && query.length > 0,
      },
    ],
    { scope },
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !view.current) return;
      event.preventDefault();
      view.current.scale(clampZoom(scaleRef.current * Math.exp(-event.deltaY / 100)));
    };
    let gestureStart = 1;
    const start = (event: Event) => {
      event.preventDefault();
      gestureStart = scaleRef.current;
    };
    const change = (event: Event) => {
      event.preventDefault();
      const value = (event as Event & { scale: number }).scale;
      if (Number.isFinite(value)) view.current?.scale(clampZoom(gestureStart * value));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', start);
    element.addEventListener('gesturechange', change);
    return () => {
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('gesturestart', start);
      element.removeEventListener('gesturechange', change);
    };
  }, []);

  const print = async () => {
    try {
      const words = fileActionWords(await openFileOutside(rootId, path));
      if (words) useUiStore.getState().toast(words);
    } catch {
      useUiStore.getState().toast("Couldn't open this PDF for printing");
    }
  };
  return (
    <scope.Provider>
      <section
        {...scope.props}
        className="pdf-viewer"
        data-testid="pdf-viewer"
        aria-label="PDF document"
      >
        {!ready && (
          <p role="status" data-testid={`pdf-${state.state}`}>
            {WORDS[state.state]}
          </p>
        )}
        {ready && (
          <>
            <div className="pdf-toolbar" role="toolbar" aria-label="PDF controls">
              <button
                type="button"
                className="cb-btn cb-btn-sm cb-btn-ghost"
                aria-expanded={outlineOpen}
                onClick={() => setOutlineOpen((value) => !value)}
              >
                Outline
              </button>
              <label>
                Page{' '}
                <input
                  ref={pageInput}
                  aria-label="PDF page"
                  inputMode="numeric"
                  value={pageDraft}
                  onChange={(event) => setPageDraft(event.target.value)}
                  onBlur={jump}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      jump();
                    }
                  }}
                />
              </label>
              <span>/ {total}</span>
              <button
                type="button"
                className="cb-btn cb-btn-sm cb-btn-ghost"
                aria-label="Zoom out"
                disabled={scale <= 0.25}
                onClick={() => zoom(stepZoom(scale, -1))}
              >
                −
              </button>
              <output aria-label="PDF zoom">{Math.round(scale * 100)}%</output>
              <button
                type="button"
                className="cb-btn cb-btn-sm cb-btn-ghost"
                aria-label="Zoom in"
                disabled={scale >= 4}
                onClick={() => zoom(stepZoom(scale, 1))}
              >
                +
              </button>
              <select
                aria-label="PDF zoom preset"
                defaultValue="page-width"
                onChange={(event) =>
                  zoom(event.target.value === '100' ? 1 : (event.target.value as PdfScale))
                }
              >
                <option value="page-width">Page width</option>
                <option value="page-fit">Page fit</option>
                <option value="100">100%</option>
              </select>
              <button
                type="button"
                className="cb-btn cb-btn-sm cb-btn-ghost"
                onClick={() => setFindOpen((value) => !value)}
              >
                Find
              </button>
              <button
                type="button"
                className="cb-btn cb-btn-sm cb-btn-ghost"
                disabled={!desktopFileActions()}
                title={desktopFileActions() ? 'Open in your PDF app to print' : 'Desktop app only'}
                onClick={() => void print()}
              >
                Print…
              </button>
            </div>
            {findOpen && (
              <div
                className="pdf-find"
                role="search"
                aria-label="Find in PDF"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeFind();
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    find(true, event.shiftKey);
                  }
                }}
              >
                <input
                  ref={findInput}
                  aria-label="Find in PDF"
                  value={query}
                  disabled={text === 'no'}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setMatches({ current: 0, total: 0 });
                    view.current?.find(event.target.value);
                  }}
                />
                <output aria-live="polite">
                  {text === 'no' ? 'No text to search' : matchWords(matches, query)}
                </output>
                <button
                  type="button"
                  className="cb-btn cb-btn-sm cb-btn-ghost"
                  disabled={!query}
                  onClick={() => find(true, true)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="cb-btn cb-btn-sm cb-btn-ghost"
                  disabled={!query}
                  onClick={() => find(true)}
                >
                  Next
                </button>
                <button
                  type="button"
                  className="cb-btn cb-btn-sm cb-btn-ghost"
                  aria-label="Close PDF find"
                  onClick={closeFind}
                >
                  Close
                </button>
              </div>
            )}
            {text === 'no' && (
              <p className="pdf-notice">
                This PDF has no text layer. Its pages may be scanned images.
              </p>
            )}
            {text === 'unavailable' && (
              <p className="pdf-notice">Could not check this PDF's text layer.</p>
            )}
            {failed.length > 0 && (
              <p className="pdf-notice" role="status">
                Could not draw {failed.length === 1 ? 'page' : 'pages'} {failed.join(', ')}.
              </p>
            )}
          </>
        )}
        <div className="pdf-body" hidden={!ready}>
          {outlineOpen && (
            <nav className="pdf-outline" aria-label="PDF outline">
              {outlineFailed ? (
                <p>Could not read the outline.</p>
              ) : outline === null ? (
                <p>Reading outline…</p>
              ) : outline.length === 0 ? (
                <p>No outline</p>
              ) : (
                <Outline rows={outline} jump={(number) => view.current?.page(number)} />
              )}
            </nav>
          )}
          <div className="pdf-page-area">
            <div ref={container} className="pdf-scroll" tabIndex={0} aria-label="PDF pages">
              <div className="pdfViewer" />
            </div>
          </div>
        </div>
      </section>
    </scope.Provider>
  );
}

function Outline({ rows, jump }: { rows: OutlineItem[]; jump: (page: number) => void }) {
  return (
    <ul>
      {rows.map((row, index) => (
        <li key={index}>
          {row.children.length ? (
            <details open>
              <summary>
                <button
                  disabled={row.page === null}
                  onClick={(event) => {
                    event.preventDefault();
                    if (row.page !== null) jump(row.page);
                  }}
                >
                  {row.title}
                </button>
              </summary>
              <Outline rows={row.children} jump={jump} />
            </details>
          ) : (
            <button
              disabled={row.page === null}
              onClick={() => {
                if (row.page !== null) jump(row.page);
              }}
            >
              {row.title}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
