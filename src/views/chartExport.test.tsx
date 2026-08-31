import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useUiStore } from '@/stores/uiStore';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import { ChartView } from '@/views/ChartView';
import type { Entry, Presentation } from '@/engine/types';

// The drilldown routes through the app's one routing law — mocked whole, the
// ChartView.test convention, so rendering needs no nav stores.
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => vi.fn() }));

// Only the four IO affordances are mocked — the MermaidLightbox convention.
// `chartSvgString` and `cssColorResolver` stay real: they are the pure layer
// this file exists to measure, and a whole-module factory would hand back
// undefined for them.
vi.mock('@/views/chartExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/views/chartExport')>()),
  copyChartSvg: vi.fn().mockResolvedValue(undefined),
  copyChartPng: vi.fn().mockResolvedValue(undefined),
  saveChartPng: vi.fn().mockResolvedValue('/tmp/x.png'),
  saveChartSvg: vi.fn().mockResolvedValue('/tmp/x.svg'),
}));

import {
  chartSvgString,
  copyChartPng,
  copyChartSvg,
  cssColorResolver,
  saveChartPng,
  saveChartSvg,
} from '@/views/chartExport';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Chart export (M44.3).
 *
 * The pure half: our charts paint in CSS custom properties (`var(--opt-*)`,
 * `color-mix(...)`) that only resolve while the svg sits in the app's
 * document — detached, every token collapses to black. `chartSvgString` must
 * hand out markup whose paints are LITERAL. The component half: the export
 * menu exists exactly where there is an svg to leave — bar, line, donut — and
 * follows the lightbox's toast law: cancel (resolved null) says nothing.
 */

const MIX = 'color-mix(in srgb, var(--opt-red) 65%, var(--surface-app))';

function fixtureSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 640 320');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('fill', 'var(--opt-blue)');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', MIX);
  // Literal paints exist in no chart of ours today, but a pass-through claim
  // needs a witness.
  const literal = document.createElementNS(SVG_NS, 'text');
  literal.setAttribute('fill', '#fff');
  literal.textContent = 'Todo';
  const styled = document.createElementNS(SVG_NS, 'circle');
  styled.setAttribute('style', 'fill: var(--n-0); stroke-width: 2');
  // The ticks' mono face — the one non-colour token our charts write.
  const tick = document.createElementNS(SVG_NS, 'text');
  tick.setAttribute('font-family', 'var(--font-mono)');
  tick.textContent = '4';
  svg.append(rect, path, literal, styled, tick);
  document.body.appendChild(svg);
  return svg;
}

const APP_FACE = "'Instrument Sans', sans-serif";
const MONO_FACE = "'SF Mono', monospace";

/** The production shape: the app face stamped, the mono token resolved. */
const FONT = {
  root: APP_FACE,
  resolve: (expr: string) => (expr === 'var(--font-mono)' ? MONO_FACE : expr),
};

const TABLE: Record<string, string> = {
  'var(--opt-blue)': 'rgb(35, 131, 226)',
  [MIX]: 'rgb(196, 84, 61)',
  'var(--n-0)': 'rgb(255, 255, 255)',
};

describe('chartSvgString', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('rewrites every token to a literal — no var() survives anywhere in the output', () => {
    const el = fixtureSvg();
    const out = chartSvgString(el, (expr) => TABLE[expr] ?? expr, FONT);
    expect(out).toContain('fill="rgb(35, 131, 226)"');
    expect(out).toContain('stroke="rgb(196, 84, 61)"');
    // The whole-output pin: paints AND faces, attributes AND styles.
    expect(out).not.toContain('var(');
    expect(out).not.toContain('color-mix(');
  });

  it('stamps the root with the app face and resolves font-family tokens', () => {
    const el = fixtureSvg();
    const out = chartSvgString(el, (expr) => TABLE[expr] ?? expr, FONT);
    // The root names the face — without it a detached document inherits from
    // nobody and the embedded @font-face sits unreferenced.
    const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
    expect(doc.documentElement.getAttribute('font-family')).toBe(APP_FACE);
    // The ticks' mono token went through the injected font resolver.
    expect(out).toContain(`font-family="${MONO_FACE}"`);
    expect(out).not.toContain('var(--font-mono)');
  });

  it('passes literal paints through untouched, without probing them', () => {
    const el = fixtureSvg();
    const resolve = vi.fn((expr: string) => TABLE[expr] ?? expr);
    const out = chartSvgString(el, resolve);
    expect(out).toContain('fill="#fff"');
    expect(out).toContain('fill="none"');
    expect(resolve).not.toHaveBeenCalledWith('#fff');
    expect(resolve).not.toHaveBeenCalledWith('none');
  });

  it('resolves inline style colours and keeps the non-colour declarations', () => {
    const el = fixtureSvg();
    const out = chartSvgString(el, (expr) => TABLE[expr] ?? expr);
    expect(out).toContain('fill: rgb(255, 255, 255)');
    expect(out).toContain('stroke-width: 2');
  });

  it('leaves the live element alone and returns a parseable standalone document', () => {
    const el = fixtureSvg();
    const out = chartSvgString(el, (expr) => TABLE[expr] ?? expr);
    // The element the app is still rendering keeps its tokens.
    expect(el.querySelector('rect')?.getAttribute('fill')).toBe('var(--opt-blue)');
    const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.documentElement.namespaceURI).toBe(SVG_NS);
  });
});

describe('cssColorResolver', () => {
  // Restored individually — `vi.restoreAllMocks()` would also wipe the
  // module-mocked affordances the menu suite below depends on.
  let spy: MockInstance;
  afterEach(() => {
    spy.mockRestore();
    document.body.replaceChildren();
  });

  it('probes the host once per expression and removes the probe on dispose', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    spy = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ color: 'rgb(1, 2, 3)' } as CSSStyleDeclaration);
    const resolver = cssColorResolver(host);
    expect(resolver.resolve('var(--x)')).toBe('rgb(1, 2, 3)');
    expect(resolver.resolve('var(--x)')).toBe('rgb(1, 2, 3)');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(host.childElementCount).toBe(1);
    resolver.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('falls back to the raw expression when the probe reads nothing', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    spy = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ color: '' } as CSSStyleDeclaration);
    const resolver = cssColorResolver(host);
    expect(resolver.resolve('var(--unset)')).toBe('var(--unset)');
    resolver.dispose();
  });

  it('resolves font expressions through the probe’s computed fontFamily', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    spy = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ color: '', fontFamily: MONO_FACE } as CSSStyleDeclaration);
    const resolver = cssColorResolver(host);
    expect(resolver.resolveFont('var(--font-mono)')).toBe(MONO_FACE);
    resolver.dispose();
  });
});

// --- The export menu on ChartView -------------------------------------------

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: { kind: 'status' }, estimate: { kind: 'number' } },
      statuses: [
        { id: 'todo', group: 'active', color: 'blue' },
        { id: 'doing', group: 'active', color: 'orange' },
      ],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'A',
    type: 'Work item',
    properties: { status: 'todo', estimate: 3 },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'B',
    type: 'Work item',
    properties: { status: 'doing', estimate: 5 },
  }),
];

const records = (entries: Entry[]) => entries.filter((e) => e.path.startsWith('items/'));

const view = (over: Partial<Presentation> = {}): Presentation => ({
  type: 'chart',
  group: [{ field: 'status' }],
  sort: [],
  columns: [],
  ...over,
});

function renderChart(over: Partial<Presentation> = {}, entries = vault()) {
  return render(
    <ChartView
      filtered={false}
      entries={records(entries)}
      presentation={view(over)}
      schema={buildSchema(entries)}
    />,
  );
}

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'Export chart' }));
}

describe('ChartView export menu', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(copyChartSvg).mockClear();
    vi.mocked(copyChartPng).mockClear();
    vi.mocked(saveChartPng).mockClear();
    vi.mocked(saveChartSvg).mockClear();
  });
  afterEach(cleanup);

  it.each([
    ['bar', {}],
    ['line', { chart: { kind: 'line' } } as Partial<Presentation>],
    ['donut', { chart: { kind: 'donut' } } as Partial<Presentation>],
  ])('renders for a %s chart', (_kind, over) => {
    renderChart(over);
    expect(screen.getByTestId('chart-export')).toBeTruthy();
  });

  it('does not render for the number kind — there is no svg to leave', () => {
    renderChart({ group: [], chart: { kind: 'number' } });
    expect(screen.queryByTestId('chart-export')).toBeNull();
  });

  it('does not render when the chart is blocked', () => {
    render(<ChartView filtered entries={[]} presentation={view()} schema={buildSchema([])} />);
    expect(screen.getByTestId('chart-empty')).toBeTruthy();
    expect(screen.queryByTestId('chart-export')).toBeNull();
  });

  it('Copy SVG hands the chart svg and its figure to the export layer, then toasts', async () => {
    renderChart();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy SVG' }));
    await waitFor(() => expect(vi.mocked(copyChartSvg)).toHaveBeenCalledTimes(1));
    const [el, host] = vi.mocked(copyChartSvg).mock.calls[0];
    expect(el.querySelector('[data-testid="chart-bar"]')).toBeTruthy();
    expect(host.contains(el)).toBe(true);
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('SVG copied');
  });

  it('the donut menu aims at the donut’s own svg root', async () => {
    renderChart({ chart: { kind: 'donut' } });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy PNG' }));
    await waitFor(() => expect(vi.mocked(copyChartPng)).toHaveBeenCalledTimes(1));
    const [el] = vi.mocked(copyChartPng).mock.calls[0];
    expect(el.querySelector('[data-testid="chart-arc"]')).toBeTruthy();
  });

  it('Save PNG… names the file after the chart and toasts on a chosen path', async () => {
    renderChart();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save PNG…' }));
    await waitFor(() => expect(vi.mocked(saveChartPng)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveChartPng).mock.calls[0][2]).toMatch(/\.png$/);
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('PNG saved');
  });

  it('Save SVG… goes through the export layer with an .svg name', async () => {
    renderChart();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save SVG…' }));
    await waitFor(() => expect(vi.mocked(saveChartSvg)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveChartSvg).mock.calls[0][2]).toMatch(/\.svg$/);
  });

  it('a cancelled save (resolved null) toasts nothing', async () => {
    vi.mocked(saveChartPng).mockResolvedValueOnce(null);
    renderChart();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save PNG…' }));
    await waitFor(() => expect(vi.mocked(saveChartPng)).toHaveBeenCalled());
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a rejected copy toasts the specific failure', async () => {
    vi.mocked(copyChartPng).mockRejectedValueOnce(new Error('denied'));
    renderChart();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy PNG' }));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('Copy PNG failed');
  });
});
