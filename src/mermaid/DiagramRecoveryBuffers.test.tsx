import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DocumentOwner } from '@/editor/documentOwner';
import { createRecoveryCapture, RecoveryBufferContext } from '@/editor/recoveryBuffers';
import { CodeOverlay } from './CodeOverlay';
it('retains Auto-update-off code before preparation or unmount, including source association', () => {
  const owner = new DocumentOwner(
    { vaultId: '/vault', path: 'gone.mmd', ownerId: 'pane' },
    'graph TD',
    vi.fn(),
  );
  const capture = createRecoveryCapture();
  capture.bind(owner);
  const view = render(
    <RecoveryBufferContext.Provider value={capture}>
      <CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={() => {}} />
    </RecoveryBufferContext.Provider>,
  );
  fireEvent.click(screen.getByRole('switch', { name: 'Auto-update' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Mermaid source' }), {
    target: { value: 'graph TD\n  [incomplete 😀' },
  });
  expect(Object.values(owner.snapshot().childDrafts!).map((text) => JSON.parse(text))).toEqual([
    { kind: 'diagram-code', source: 'graph TD', text: 'graph TD\n  [incomplete 😀' },
  ]);
  view.unmount();
  expect(Object.keys(owner.snapshot().childDrafts!)).toHaveLength(1);
});
