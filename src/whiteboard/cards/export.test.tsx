import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { chartSvgString } from '@/views/chartExport';
import { SceneSvg } from '../SceneSvg';
import { boardExportElement } from './export';
afterEach(cleanup);
it('export carries pointer text with no live HTML, scheme URL or unresolved paint', () => {
  const board = createBoard({
    nodes: [
      {
        id: 'a',
        type: 'file',
        file: 'attachments/poster.png',
        color: '4',
        x: 0,
        y: 0,
        width: 320,
        height: 240,
      },
    ],
  });
  render(
    <SceneSvg
      board={board}
      renderNodeContent={() => (
        <div>
          <img src="cerebro-file://localhost/0/attachments/poster.png" />
          <button>Open</button>
        </div>
      )}
    />,
  );
  const scene = screen.getByTestId('wb-scene') as unknown as SVGSVGElement;
  const exported = chartSvgString(boardExportElement(scene), () => '#112233');
  expect(exported).toContain('attachments/poster.png');
  for (const forbidden of ['foreignObject', 'cerebro-file:', 'var(', '<img', '<button'])
    expect(exported).not.toContain(forbidden);
  expect(scene.querySelector('foreignObject img')).not.toBeNull();
});
