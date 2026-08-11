import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { neutralizeDiagramLinks } from './svgLinks';

/**
 * Conformance, not unit testing (M29.38): WHICH diagram types put a live
 * navigation target in the svg mermaid hands us at `securityLevel: 'strict'`,
 * and HOW IT IS SPELLED. Both questions are claims about the BUNDLED build
 * (11.16.0), measured here rather than read off the vendored 11.16.1 source,
 * because the read-only viewers inject that svg straight into the page.
 *
 * `flowchart/links.mermaid.test.ts` already establishes that a flowchart
 * `click` line survives strict mode as a real `<a href>`. What this file adds
 * is the part that decided `neutralizeDiagramLinks`'s implementation: the
 * flowchart spelling is NOT the only one. stateDiagram-v2 writes the SVG 1.1
 * `xlink:href` instead, which `querySelectorAll('a[href]')` — the selector
 * `bindFlowchartSvg` used to carry — does not match at all, and which WebKit
 * still follows. Hence matching by attribute LOCAL NAME.
 */

const TIMEOUT = 60_000;

function polyfill(): void {
  // jsdom implements no SVG layout; every shape handler sizes itself from the
  // label's bbox. Fixed values keep renders comparable and finite.
  const proto = (globalThis as unknown as { SVGElement: { prototype: Record<string, unknown> } })
    .SVGElement.prototype;
  proto.getBBox = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto.getComputedTextLength = () => 60;
}

let seq = 0;

async function renderSvg(code: string): Promise<string> {
  seq += 1;
  const el = document.createElement('div');
  document.body.appendChild(el);
  try {
    const { svg } = await mermaid.render(`svglinks${seq}`, code, el);
    return svg;
  } finally {
    el.remove();
  }
}

/** Injected the way every read-only sink injects it — through the HTML parser. */
function host(markup: string): HTMLDivElement {
  const el = document.createElement('div');
  el.insertAdjacentHTML('afterbegin', markup);
  return el;
}

function targets(root: ParentNode): { plain: string[]; xlink: string[] } {
  const anchors = [...root.querySelectorAll('a')];
  return {
    plain: anchors.flatMap((a) => (a.hasAttribute('href') ? [a.getAttribute('href')!] : [])),
    xlink: anchors.flatMap((a) =>
      a.hasAttribute('xlink:href') ? [a.getAttribute('xlink:href')!] : [],
    ),
  };
}

const LINKED: [string, string][] = [
  ['flowchart', 'flowchart TD\n  A[Start] --> B\n  click A "notes/a.md"'],
  [
    'classDiagram',
    'classDiagram\n  class Shape\n  class Box\n  Shape <|-- Box\n  link Shape "notes/a.md"',
  ],
  ['stateDiagram', 'stateDiagram-v2\n  [*] --> S1\n  S1 --> [*]\n  click S1 href "notes/a.md"'],
  [
    'sequenceDiagram',
    'sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: hi\n  link Alice: Dash @ notes/a.md',
  ],
];

describe('what a rendered diagram can navigate to (M29.38)', () => {
  it(
    'strict emits real anchors, in TWO different spellings',
    async () => {
      polyfill();
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', handDrawnSeed: 1 });

      const measured: Record<string, unknown> = {};
      for (const [name, code] of LINKED) {
        measured[name] = targets(host(await renderSvg(code)));
      }
      expect(measured).toEqual({
        // The two that wrap the node group itself.
        flowchart: { plain: ['notes/a.md'], xlink: [] },
        classDiagram: { plain: ['notes/a.md'], xlink: [] },
        // The one an `a[href]` selector would sail straight past.
        stateDiagram: { plain: [], xlink: ['notes/a.md'] },
        // Not a node at all — the actor popup menu.
        sequenceDiagram: { plain: ['notes/a.md'], xlink: [] },
      });

      // Where they sit, since it decides that stripping the ATTRIBUTE is the
      // only safe move: the anchor WRAPS content the app has other plans for.
      const flow = host(await renderSvg(LINKED[0][1]));
      const anchor = flow.querySelector('a')!;
      expect(anchor.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(anchor.querySelector('g.node')).not.toBeNull();

      // Nothing but an `<a>` carries a target in this output, which is why the
      // helper can restrict itself to anchors and leave `<use>`/`<image>`
      // references alone without missing anything.
      for (const [name, code] of LINKED) {
        const tags = [...host(await renderSvg(code)).querySelectorAll('[*|href]')].map(
          (e) => e.tagName,
        );
        expect([name, [...new Set(tags)]]).toEqual([name, ['a']]);
      }
    },
    TIMEOUT,
  );

  it(
    'neutralizeDiagramLinks leaves every one of them inert, and the picture intact',
    async () => {
      polyfill();
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', handDrawnSeed: 1 });

      for (const [name, code] of LINKED) {
        const el = host(await renderSvg(code));
        const anchors = [...el.querySelectorAll('a')];
        expect([name, anchors.length]).toEqual([name, 1]);
        const wrapped = anchors[0].firstElementChild;

        neutralizeDiagramLinks(el);

        expect([name, targets(el)]).toEqual([name, { plain: [], xlink: [] }]);
        // An anchor with no target is not even keyboard-focusable — the whole
        // reason the attribute goes rather than the click being intercepted.
        expect([name, [...el.querySelectorAll('a')]]).toEqual([name, anchors]);
        expect([name, anchors[0].firstElementChild]).toEqual([name, wrapped]);
      }

      // An absolute target is neutralized on exactly the same terms. Opening
      // it in the system browser would be a feature; navigating the webview to
      // it is just losing the app.
      const ext = host(
        await renderSvg('flowchart TD\n  A[Start] --> B\n  click A "https://example.com"'),
      );
      expect(targets(ext).plain).toEqual(['https://example.com/']);
      neutralizeDiagramLinks(ext);
      expect(targets(ext)).toEqual({ plain: [], xlink: [] });
    },
    TIMEOUT,
  );
});
