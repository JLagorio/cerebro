import { expect, it } from 'vitest';
import mermaid from 'mermaid';
import { neutralizeRemoteImages } from './remoteImages';
import { renderMermaid } from './render';

it('keeps ordinary shapes, labels, icons and color styles valid for the bundled parser', async () => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const source = `flowchart TD
 A@{ shape: cyl, label: "Cache" }
 B@{ icon: "lucide:rocket", form: "rounded", label: "Launch" }
 C@{ shape: rect, label: "A {braced} label" }
 A --> B --> C
 classDef quiet fill:#eeeeee,stroke:#333333
 class A quiet`;
  const clean = neutralizeRemoteImages(source);
  expect(clean).toContain('lucide:rocket');
  expect(clean).toContain('A {braced} label');
  expect(clean).toContain('fill:#eeeeee');
  await expect(mermaid.parse(clean)).resolves.toMatchObject({ diagramType: 'flowchart-v2' });
});

it('keeps a record-linked diagram visible through the production resource sanitizer', async () => {
  const proto = SVGElement.prototype as SVGElement & {
    getBBox: () => { x: number; y: number; width: number; height: number };
    getComputedTextLength: () => number;
  };
  proto.getBBox = () => ({ x: 0, y: 0, width: 60, height: 20 });
  proto.getComputedTextLength = () => 60;
  const result = await renderMermaid('flowchart TD\n A[Start] --> B\n click A "people/ana.md"');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.svg).toContain('flowchart-A-');
  const host = document.createElement('div');
  host.innerHTML = result.svg;
  expect(host.querySelectorAll('g.node')).toHaveLength(2);
});
