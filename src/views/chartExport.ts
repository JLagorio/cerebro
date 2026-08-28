import { exportSvg as ipcExportSvg } from '@/lib/ipc';
import { copyPng, embeddedFontCss, savePng, withBackground, withFontFace } from '@/mermaid/export';

/**
 * Chart export (M44.3) — the mermaid pipeline (M29.4) reused for the charts
 * the app draws itself, with the one problem mermaid never posed solved
 * first: mermaid writes literal colours, our charts paint in CSS custom
 * properties (`var(--opt-*)`, `color-mix(...)`) that only resolve while the
 * svg sits in the app's document. Detached — a clipboard paste, a saved
 * file — every token collapses to black. So serialization rewrites each
 * token-bearing paint into the literal the theme resolves it to right now,
 * which also means a dark-theme export leaves dark, permanently.
 *
 * The transformation is `chartSvgString(el, resolve)` with the DOM-reading
 * resolver injected, so the pure rewrite is testable without a browser that
 * can actually compute `color-mix()` (jsdom cannot).
 */

const needsResolve = (value: string): boolean =>
  value.includes('var(') || value.includes('color-mix(');

/** The inline-style properties that hold a colour. Only these go through the
 * probe — resolving `font-family: var(--font-mono)` AS a colour would hand
 * back the probe's inherited text colour, silently wrong. */
const COLOR_PROPS = new Set(['fill', 'stroke', 'color', 'stop-color']);

/** One style attribute, its colour declarations resolved, the rest verbatim.
 * Splitting on `;` is safe here: of the expressions we resolve, neither
 * `var()` nor `color-mix()` can contain one. */
function resolveStyle(style: string, resolve: (expr: string) => string): string {
  return style
    .split(';')
    .map((decl) => {
      const at = decl.indexOf(':');
      if (at === -1) return decl;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).trim();
      if (!COLOR_PROPS.has(prop) || !needsResolve(value)) return decl;
      return `${prop}: ${resolve(value)}`;
    })
    .join(';');
}

/** The face the export text wears: the resolved family to stamp on the root,
 * and the resolver for any `font-family` attribute that names a token. */
export interface FontOptions {
  root?: string;
  resolve?: (expr: string) => string;
}

/**
 * The chart element as a standalone SVG document string: a clone — the live
 * element keeps rendering with its tokens — with every `fill`/`stroke`
 * attribute and inline-style colour that names a token rewritten through
 * `resolve`, and every `font-family` token rewritten through `font.resolve`.
 * Literal paints (`#fff`, `none`) pass through unprobed.
 *
 * `font.root` is stamped onto the cloned root: no chart text names a family
 * of its own — inside the app every label inherits the figure's — and a
 * detached document inherits from nobody, so without the stamp the embedded
 * `@font-face` sits unreferenced and every label renders in the viewer's
 * default serif.
 */
export function chartSvgString(
  el: SVGSVGElement,
  resolve: (expr: string) => string,
  font?: FontOptions,
): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  if (font?.root !== undefined && font.root !== '') clone.setAttribute('font-family', font.root);
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attr of ['fill', 'stroke'] as const) {
      const value = node.getAttribute(attr);
      if (value !== null && needsResolve(value)) node.setAttribute(attr, resolve(value));
    }
    // The one non-colour token our charts write: the ticks' mono face.
    const family = node.getAttribute('font-family');
    if (family !== null && family.includes('var(') && font?.resolve !== undefined) {
      node.setAttribute('font-family', font.resolve(family));
    }
    const style = node.getAttribute('style');
    if (style !== null && needsResolve(style)) {
      node.setAttribute('style', resolveStyle(style, resolve));
    }
  }
  // XMLSerializer writes the xmlns the standalone document needs; outerHTML
  // (an HTML serialization) would not.
  return new XMLSerializer().serializeToString(clone);
}

export interface ColorResolver {
  resolve: (expr: string) => string;
  /** The same probe, read through `fontFamily` — for the ticks' mono token. */
  resolveFont: (expr: string) => string;
  dispose: () => void;
}

/**
 * The production resolver: a hidden probe span inside `host` — the figure,
 * so the probe computes under exactly the custom properties the chart drew
 * with — takes each expression as its `color` (or `fontFamily`) and reads
 * the literal back out of `getComputedStyle`. Cached per expression, per
 * lane; a probe that reads nothing (an undefined token) keeps the raw
 * expression, degrading to what the markup already said.
 */
export function cssColorResolver(host: HTMLElement): ColorResolver {
  const colors = new Map<string, string>();
  const fonts = new Map<string, string>();
  let probe: HTMLSpanElement | null = null;
  const ensureProbe = (): HTMLSpanElement => {
    if (probe === null) {
      probe = document.createElement('span');
      probe.style.display = 'none';
      host.appendChild(probe);
    }
    return probe;
  };
  const through = (
    cache: Map<string, string>,
    prop: 'color' | 'fontFamily',
    expr: string,
  ): string => {
    const hit = cache.get(expr);
    if (hit !== undefined) return hit;
    const el = ensureProbe();
    el.style[prop] = expr;
    const computed = getComputedStyle(el)[prop];
    const literal = computed === '' ? expr : computed;
    cache.set(expr, literal);
    return literal;
  };
  return {
    resolve: (expr) => through(colors, 'color', expr),
    resolveFont: (expr) => through(fonts, 'fontFamily', expr),
    dispose(): void {
      probe?.remove();
      probe = null;
    },
  };
}

/** The ground the figure shows the chart on, read live — so a dark-theme
 * export is dark. The fallback covers a host with no computed paint (jsdom,
 * a detached figure), where white is the one safe ground. */
function figureBackground(host: HTMLElement): string {
  const bg = getComputedStyle(host).backgroundColor;
  return bg === '' || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' ? '#ffffff' : bg;
}

/** The string every affordance below hands on: tokens resolved, the figure's
 * ground painted in, the figure's computed `font-family` stamped on the root
 * so every label actually names the app's face — which is what makes the
 * embedded `@font-face` bytes worth carrying. */
async function prepared(el: SVGSVGElement, host: HTMLElement): Promise<string> {
  const resolver = cssColorResolver(host);
  try {
    const svg = chartSvgString(el, resolver.resolve, {
      root: getComputedStyle(host).fontFamily,
      resolve: resolver.resolveFont,
    });
    return withFontFace(withBackground(svg, figureBackground(host)), await embeddedFontCss());
  } finally {
    resolver.dispose();
  }
}

// Like the mermaid pair these compose, the copy functions let failures
// propagate — the menu's `act` shows the affordance-specific toast.

export async function copyChartSvg(el: SVGSVGElement, host: HTMLElement): Promise<void> {
  // NOT mermaid's copySvg: that helper paints its own theme background and
  // font face onto whatever string it gets, and this string already carries
  // the figure's — reusing it would nest a second rect and a second style
  // into markup the user keeps. The clipboard call is all that remains.
  await navigator.clipboard.writeText(await prepared(el, host));
}

// The PNG pair DOES reuse copyPng/savePng whole. Their rasterizer paints the
// mermaid theme background under ours — ours sits later in document order,
// so the pixels that leave are the figure's, and inside a raster the
// redundant rect costs nothing; reimplementing the canvas plumbing to avoid
// it would.

export async function copyChartPng(el: SVGSVGElement, host: HTMLElement): Promise<void> {
  await copyPng(await prepared(el, host));
}

/** Save through the native dialog. Resolves to the chosen path, or null on cancel. */
export async function saveChartPng(
  el: SVGSVGElement,
  host: HTMLElement,
  defaultName: string,
): Promise<string | null> {
  return savePng(await prepared(el, host), defaultName);
}

/** Save the markup itself. Resolves to the chosen path, or null on cancel. */
export async function saveChartSvg(
  el: SVGSVGElement,
  host: HTMLElement,
  defaultName: string,
): Promise<string | null> {
  return ipcExportSvg(defaultName, await prepared(el, host));
}
