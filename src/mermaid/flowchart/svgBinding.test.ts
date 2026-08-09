import { describe, expect, it } from 'vitest';
import { parseFlowchart } from './model';
import { bindFlowchartSvg } from './svgBinding';

const SVG = [
  '<svg viewBox="0 0 100 100">',
  '  <g class="node default" id="flowchart-A-0"><rect/></g>',
  '  <g class="node default" id="flowchart-B-1"><rect/></g>',
  '  <g class="node default" id="flowchart-my-node-2"><rect/></g>',
  '  <path class="edge-thickness-normal edge-pattern-solid flowchart-link" id="L_A_B_0"/>',
  '  <path class="flowchart-link" id="L_B_my-node_0"/>',
  '</svg>',
].join('\n');

describe('bindFlowchartSvg', () => {
  it('maps node groups and edge paths back to model ids — dashes included', () => {
    const model = parseFlowchart(
      'flowchart TD\n  A[One] --> B[Two]\n  B --> my-node[Three]',
    )!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = SVG;
    const binding = bindFlowchartSvg(host, model);
    expect([...binding.nodeEls.keys()].sort()).toEqual(['A', 'B', 'my-node']);
    expect(binding.edgeEls).toHaveLength(2);
    expect(binding.edgeEls[1]).toMatchObject({ from: 'B', to: 'my-node' });
  });

  it('ignores svg elements that match nothing in the model', () => {
    const model = parseFlowchart('flowchart TD\n  A[One] --> B[Two]')!;
    const host = document.createElement('div');
    // Test fixture: fixed literal SVG markup, not user-supplied content.
    host.innerHTML = SVG;
    const binding = bindFlowchartSvg(host, model);
    expect(binding.nodeEls.has('my-node')).toBe(false);
    expect(binding.edgeEls).toHaveLength(1);
  });
});
