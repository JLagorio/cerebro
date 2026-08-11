/**
 * Mermaid theme variables derived from Cerebro's design tokens (M29.1).
 *
 * Read at render time, not import time: `getComputedStyle` resolves whatever
 * palette `<html data-theme>` currently selects (M16.39 added dark), so
 * diagrams follow a theme flip without knowing themes exist. Fallbacks are
 * the light values from `src/styles/tokens/colors.css`, for environments
 * that load no stylesheet (vitest).
 */

export function buildThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => {
    const v = style.getPropertyValue(name).trim();
    return v === '' ? fallback : v;
  };
  const ink = token('--n-800', '#272d3b');
  const nodeFill = token('--cortex-50', '#eef1fe');
  const nodeBorder = token('--cortex-500', '#3d5bde');
  return {
    fontFamily: token('--font-ui', "'Instrument Sans', -apple-system, 'Segoe UI', sans-serif"),
    fontSize: '13px',
    background: token('--n-0', '#ffffff'),
    primaryColor: nodeFill,
    primaryTextColor: ink,
    primaryBorderColor: nodeBorder,
    secondaryColor: token('--n-50', '#f6f7fa'),
    tertiaryColor: token('--n-25', '#fbfbfd'),
    lineColor: token('--n-400', '#888fa3'),
    textColor: ink,
    mainBkg: nodeFill,
    nodeBorder: nodeBorder,
    clusterBkg: token('--n-25', '#fbfbfd'),
    clusterBorder: token('--n-200', '#e3e6ee'),
    edgeLabelBackground: token('--n-0', '#ffffff'),
  };
}

/**
 * Per-diagram font sizes (M29.53).
 *
 * `fontSize: '13px'` is a theme VARIABLE, and only some renderers read it:
 * MEASURED in one 638px document column, the flowchart's smallest text was
 * 13px, the sequence diagram's 16px and the gantt's 10px — three sizes for one
 * document. Sequence and gantt take theirs from their own config blocks
 * instead, which is what this sets. Kept beside the palette because it is the
 * same decision ("what a diagram looks like in this app") reached by a
 * different lever.
 */
export const DIAGRAM_FONT_CONFIG = {
  sequence: { actorFontSize: 13, messageFontSize: 13, noteFontSize: 13 },
  gantt: { fontSize: 13, sectionFontSize: 13 },
} as const;

/** Cache key component: same code under a different palette must not reuse an SVG. */
export function themeSignature(vars: Record<string, string>): string {
  return Object.values(vars).join('|');
}
