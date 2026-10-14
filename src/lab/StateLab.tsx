import { Fragment, StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button } from '@/components/ui/Button';
import { armedFaults, failNext } from '@/lib/mockFaults';
import { clockLine, pinClock } from './clock';
import {
  applyPreset,
  failableCommands,
  LAB_STATES,
  labSections,
  labUrl,
  parseLabUrl,
  presetIndex,
  type LabPresetIndexRow,
  type LabSection,
  type LabState,
} from './presets';

/**
 * The state lab (M64.1): every section in `./sections/`, each in its five
 * states, mounted for real over the browser mock with the clock pinned.
 *
 * A preset is a URL (`?section=&state=`), so a state can be linked, reloaded
 * and replayed by a spec. Nothing here writes storage: the lab shares the dev
 * origin with the app, and the owner's dev session keeps its settings.
 */

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function StateLab({ sections = labSections() }: { sections?: LabSection[] }) {
  const initial = useMemo(() => parseLabUrl(window.location.search, sections), [sections]);
  const [sectionId, setSectionId] = useState(initial.section.id);
  const [state, setState] = useState<LabState>(initial.state);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  /** Bumped by Reset: the same preset applied again. */
  const [applied, setApplied] = useState(0);
  /** Bumped by Remount and by every apply: a fresh mount of the section. */
  const [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [command, setCommand] = useState('');
  const [armed, setArmed] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const commands = useMemo(() => failableCommands(sections), [sections]);

  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    void applyPreset(section, state, controller.signal).then(() => {
      if (controller.signal.aborted) return;
      setArmed(armedFaults());
      setGeneration((g) => g + 1);
      setReady(true);
    });
    return () => controller.abort();
  }, [section, state, applied]);

  useEffect(() => {
    const onPop = () => {
      const parsed = parseLabUrl(window.location.search, sections);
      setSectionId(parsed.section.id);
      setState(parsed.state);
      setNotice(parsed.notice);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [sections]);

  const choose = useCallback((id: string, next: LabState) => {
    window.history.pushState(null, '', labUrl(id, next));
    setSectionId(id);
    setState(next);
    setNotice(null);
  }, []);

  const copyLink = () => {
    const href = window.location.href;
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(href))
      .then(
        () => setCopied('Link copied'),
        () => setCopied(`Copy failed — the link is ${href}`),
      );
  };

  const armFailure = () => {
    const name = command.trim();
    if (name === '') return;
    failNext(name);
    setArmed(armedFaults());
  };

  const remount = () => {
    setGeneration((g) => g + 1);
    // Read after the mount's own reads have run, so a spent fault leaves the list.
    setTimeout(() => setArmed(armedFaults()), 0);
  };

  const toggleTheme = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    setTheme(next);
  };

  const preset = section.states[state];
  const armedList = Object.entries(armed);

  return (
    <div className="flex min-h-screen bg-surface-app text-n-900">
      <nav
        data-testid="lab-sections"
        className="flex w-64 flex-none flex-col gap-3 overflow-y-auto border-r border-n-100 bg-surface-sunken p-3"
      >
        <h1 className="text-sm font-semibold">State lab</h1>
        {sections.map((s) => (
          <section key={s.id} data-testid={`lab-section-${s.id}`} className="flex flex-col gap-1">
            <h2 className="text-xs font-medium text-n-800">{s.title}</h2>
            <p className="text-2xs text-n-500">{s.surface}</p>
            <div className="flex flex-wrap gap-1">
              {LAB_STATES.map((st) => {
                const current = s.id === section.id && st === state;
                return (
                  <button
                    key={st}
                    type="button"
                    data-testid={`lab-state-${s.id}-${st}`}
                    aria-pressed={current}
                    onClick={() => choose(s.id, st)}
                    className={[
                      'rounded-md border-0 px-1.5 py-0.5 text-2xs',
                      current ? 'bg-surface-selected text-n-900' : 'bg-transparent text-n-600',
                    ].join(' ')}
                  >
                    {st}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>

      <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <header className="flex flex-wrap items-center gap-2">
          <span data-testid="lab-clock" className="text-xs text-n-600">
            {clockLine()}
          </span>
          <span className="flex-1" />
          <Button size="sm" testId="lab-copy" onClick={copyLink}>
            Copy link
          </Button>
          <Button size="sm" testId="lab-reset" onClick={() => setApplied((n) => n + 1)}>
            Reset
          </Button>
          <Button size="sm" testId="lab-theme" onClick={toggleTheme}>
            {theme === 'light' ? 'Dark' : 'Light'}
          </Button>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-2xs text-n-500">
            Fail next read of
            <input
              data-testid="lab-fail-command"
              list="lab-fail-commands"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="command"
              className="rounded-md border border-n-200 bg-transparent px-1.5 py-0.5 text-xs"
            />
          </label>
          <datalist id="lab-fail-commands">
            {commands.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Button size="sm" testId="lab-fail-next" onClick={armFailure}>
            Fail next
          </Button>
          <Button size="sm" testId="lab-remount" onClick={remount}>
            Remount
          </Button>
          <span data-testid="lab-armed" className="text-2xs text-n-500">
            {armedList.length === 0
              ? 'Nothing armed'
              : `Armed: ${armedList.map(([c, n]) => (n === 1 ? c : `${c} ×${n}`)).join(', ')}`}
          </span>
        </div>

        {notice !== null && (
          <p data-testid="lab-fallback" className="text-xs text-n-600">
            {notice}
          </p>
        )}
        {copied !== null && (
          <p data-testid="lab-copied" className="text-2xs text-n-500">
            {copied}
          </p>
        )}

        <p data-testid="lab-note" className="text-xs text-n-500">
          {section.title} · {state} — {preset.note}
        </p>

        <div
          data-testid="lab-stage"
          data-section={section.id}
          data-state={state}
          data-ready={ready ? '' : undefined}
          className="rounded-md border border-n-100 p-3"
        >
          {ready ? <Fragment key={generation}>{section.render()}</Fragment> : null}
        </div>
      </main>
    </div>
  );
}

/** The one line outside dev. */
export const REFUSAL = 'The state lab runs only under pnpm dev.';

/**
 * Mount the lab, or refuse. Outside DEV it writes one line and mounts nothing
 * — a second gate behind Vite building only index.html.
 */
export function mountStateLab(root: HTMLElement | null, dev: boolean): Root | null {
  if (root === null) throw new Error('state lab: no #root element');
  if (!dev) {
    root.textContent = REFUSAL;
    return null;
  }
  pinClock();
  (window as unknown as { __cerebroLabPresets: LabPresetIndexRow[] }).__cerebroLabPresets =
    presetIndex();
  const mounted = createRoot(root);
  mounted.render(
    <StrictMode>
      <StateLab />
    </StrictMode>,
  );
  return mounted;
}
