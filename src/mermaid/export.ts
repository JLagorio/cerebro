import { exportPng as ipcExportPng } from '@/lib/ipc';
import { buildThemeVariables } from './theme';

/**
 * Diagram export (M29.4). SVG is the lossless copy; PNG rasterises at 2×
 * through an offscreen canvas. Mermaid svgs are viewBox-sized (no width/height
 * attributes), and an <img> from such an svg reports 0×0 in some engines —
 * so intrinsic size comes from the viewBox, not the image.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function viewBoxRect(svg: string): { x: number; y: number; width: number; height: number } {
  const m = svg.match(/viewBox="([\d.-]+)[ ,]+([\d.-]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
  if (m === null) return { x: 0, y: 0, width: 800, height: 600 };
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

export function viewBoxSize(svg: string): { width: number; height: number } {
  const box = viewBoxRect(svg);
  return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

/** The lines a mermaid HTML label holds, `<br>` and block elements included. */
function labelLines(el: Element): string[] {
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
  };
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        current += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = (child as Element).tagName.toLowerCase();
      if (tag === 'br') {
        flush();
        continue;
      }
      const block = tag === 'p' || tag === 'div';
      if (block) flush();
      walk(child);
      if (block) flush();
    }
  };
  walk(el);
  flush();
  return out;
}

/**
 * Turns mermaid's HTML labels into SVG text (M29.53).
 *
 * MEASURED: Copy PNG and Save PNG… failed for every diagram type mermaid draws
 * with `htmlLabels` — flowchart (the flagship), ELK flowchart, class, state,
 * ER, journey and mindmap — while sequence, gantt, pie, timeline, gitGraph and
 * quadrant all worked. The correlation was exact, and the cause is one line
 * deep: an `<img>` whose SVG contains `<foreignObject>` taints the canvas in
 * Chromium, so `toBlob` raises "Tainted canvases may not be exported" and the
 * whole export rejects into a generic "Copy PNG failed" toast. Stripping the
 * foreignObjects makes it encode — but a diagram with no labels is not an
 * export either, so each one becomes the `<text>` it was standing in for,
 * centred in the same box and carrying the same classes, which is what the
 * svg's own stylesheet colours and sizes it by.
 *
 * The SVG copy is left alone: it is documented as the LOSSLESS one, browsers
 * render foreignObject correctly, and this transform is an approximation —
 * one line-height per line, no inline formatting.
 */
export function inlineForeignObjects(svg: string): string {
  if (!svg.includes('foreignObject')) return svg;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.getElementsByTagName('parsererror').length > 0) return svg;
  for (const fo of Array.from(root.getElementsByTagName('foreignObject'))) {
    const x = Number(fo.getAttribute('x') ?? 0) || 0;
    const y = Number(fo.getAttribute('y') ?? 0) || 0;
    const width = Number(fo.getAttribute('width') ?? 0) || 0;
    const height = Number(fo.getAttribute('height') ?? 0) || 0;
    const lines = labelLines(fo);
    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x + width / 2));
    text.setAttribute('y', String(y + height / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    // `currentColor`, because the rules mermaid writes for these labels set
    // `color` (an HTML property) and SVG text paints with `fill`. Carrying the
    // class over is what keeps the font size and family too.
    text.setAttribute('fill', 'currentColor');
    const classed = fo.querySelector('[class]')?.getAttribute('class');
    if (classed != null && classed !== '') text.setAttribute('class', classed);
    lines.forEach((line, i) => {
      const tspan = doc.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', String(x + width / 2));
      // Centre the block on the box: the first line lifts by half the stack.
      tspan.setAttribute('dy', i === 0 ? `${(-(lines.length - 1) * 1.2) / 2}em` : '1.2em');
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    fo.parentNode?.replaceChild(text, fo);
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * Paints the ground the app shows the diagram on (M29.53).
 *
 * MEASURED: 73.4% of a dark-theme PNG's pixels were fully transparent and its
 * lightest opaque pixel scored 1.06:1 against a white page — pasted into
 * Slack or a doc, a dark-theme export is invisible. `theme.ts` already hands
 * mermaid a `background` variable; mermaid never paints it into the svg, so
 * nothing carried it out of the app.
 */
export function withBackground(svg: string, color: string): string {
  const box = viewBoxRect(svg);
  const rect =
    `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" ` +
    `fill="${color}" data-cerebro-export-bg="true"/>`;
  const open = svg.match(/<svg\b[^>]*>/);
  if (open === null) return svg;
  const at = (open.index ?? 0) + open[0].length;
  return svg.slice(0, at) + rect + svg.slice(at);
}

/** The app's own paper colour, read live so a theme flip follows. */
function exportBackground(): string {
  return buildThemeVariables().background;
}

/** Anything past this stays unembedded rather than bloating every export. */
const MAX_FONT_BYTES = 2_000_000;

/**
 * The app's UI font, inlined as a data URI (M29.53).
 *
 * MEASURED: a 14,890-character exported svg named `'Instrument Sans'` in nine
 * places and carried zero `@font-face` rules. Inside the app the face is a
 * bundled .ttf that nothing outside can resolve — and the `<img>` the raster
 * path draws through is an isolated document that will not load it either — so
 * every export was set in the fallback stack while mermaid's box geometry had
 * been computed against the real one: the string "Authorization Microservice"
 * measures 197.58px in Instrument Sans and 187.63px in the fallback, 5.3%
 * narrower, in every label of every export.
 *
 * Read out of the app's OWN stylesheet rather than from a hard-coded path, so
 * it cannot drift from what the app is actually rendering with, and memoized
 * because it is a ~194KB file that never changes within a session. Every
 * failure — a cross-origin sheet, a missing rule, a fetch that will not
 * resolve — degrades to what shipped before: no rule, and the fallback face.
 */
let fontFaceCss: string | null | undefined;

function base64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on 194KB overflows the argument
  // limit and throws.
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(out);
}

export async function embeddedFontCss(): Promise<string | null> {
  if (fontFaceCss !== undefined) return fontFaceCss;
  fontFaceCss = null;
  const family = buildThemeVariables().fontFamily.split(',')[0].replace(/['"]/g, '').trim();
  if (family === '') return fontFaceCss;
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a cross-origin sheet cannot be read, and is not ours
      }
      for (const rule of Array.from(rules)) {
        if (rule.constructor.name !== 'CSSFontFaceRule') continue;
        const style = (rule as CSSFontFaceRule).style;
        if (style.getPropertyValue('font-family').replace(/['"]/g, '').trim() !== family) continue;
        // Mermaid never emits italic, and a second face would double the bytes.
        if (style.getPropertyValue('font-style').trim() === 'italic') continue;
        const url = /url\(["']?([^"')]+)["']?\)/.exec(style.getPropertyValue('src'))?.[1];
        if (url === undefined) continue;
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FONT_BYTES) continue;
        const weight = style.getPropertyValue('font-weight').trim() || 'normal';
        fontFaceCss =
          `@font-face{font-family:'${family}';` +
          `src:url(data:font/ttf;base64,${base64(bytes)}) format('truetype-variations');` +
          `font-weight:${weight};font-style:normal;}`;
        return fontFaceCss;
      }
    }
  } catch {
    // Degrade to the unembedded export, which is what shipped before.
  }
  return fontFaceCss;
}

/** Puts the face inside the svg, where a consumer of the file can reach it. */
export function withFontFace(svg: string, css: string | null): string {
  if (css === null) return svg;
  const open = svg.match(/<svg\b[^>]*>/);
  if (open === null) return svg;
  const at = (open.index ?? 0) + open[0].length;
  return `${svg.slice(0, at)}<style>${css}</style>${svg.slice(at)}`;
}

export async function svgToPngBytes(svg: string, scale = 2): Promise<Uint8Array> {
  const { width, height } = viewBoxSize(svg);
  const printable = withFontFace(
    withBackground(inlineForeignObjects(svg), exportBackground()),
    await embeddedFontCss(),
  );
  const url = URL.createObjectURL(new Blob([printable], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG failed to rasterise'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width * scale);
    canvas.height = Math.max(1, height * scale);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas 2d unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) throw new Error('PNG encode failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Both copy functions let clipboard/rasterise failures propagate to the
// caller instead of toasting here — unlike the store-layer copyText pattern
// (actions catch and toast in place). The lightbox (M29.5) is the only
// caller, and it needs the rejection itself to show a diagram-specific
// error, not a generic one raised from inside this module.

export async function copySvg(svg: string): Promise<void> {
  // Background and the font face, but no label inlining: this copy is the
  // lossless one, and every SVG consumer that matters renders foreignObject.
  await navigator.clipboard.writeText(
    withFontFace(withBackground(svg, exportBackground()), await embeddedFontCss()),
  );
}

export async function copyPng(svg: string): Promise<void> {
  const bytes = await svgToPngBytes(svg);
  // `bytes` types as Uint8Array<ArrayBufferLike>, and BlobPart wants a view
  // backed by a concrete ArrayBuffer (not SharedArrayBuffer) — re-wrapping
  // resolves the generic, same pattern mockIpc.ts uses for exportPng.
  await navigator.clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    }),
  ]);
}

/** Save through the native dialog. Resolves to the chosen path, or null on cancel. */
export async function savePng(svg: string, defaultName: string): Promise<string | null> {
  const bytes = await svgToPngBytes(svg);
  return ipcExportPng(defaultName, bytes);
}
