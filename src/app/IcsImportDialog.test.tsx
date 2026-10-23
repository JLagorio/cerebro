import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { makeEntry } from '@/test/factories';
import type { Entry } from '@/engine/types';
import type { ImportInput } from '@/engine/inlets';
import { useVaultStore } from '@/stores/vaultStore';
import { ImportInlet } from './ImportInlet';
import { IcsImportDialog } from './IcsImportDialog';
import { importIcs } from './icsActions';
vi.mock('./icsActions', async (original) => ({
  ...(await original<typeof import('./icsActions')>()),
  importIcs: vi.fn(),
}));
const input: ImportInput = {
  kind: 'calendar',
  name: 'team.ics',
  content:
    'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nSUMMARY:Paris meeting\nDTSTART;TZID=Europe/Paris:20260703T090000\nEND:VEVENT\nEND:VCALENDAR',
};
const entry = makeEntry({
  path: 'types/Gathering.md',
  title: 'Gathering',
  type: 'Type',
  properties: {
    fields: { when: { kind: 'daterange' }, guests: { kind: 'person' }, venue: { kind: 'text' } },
  } as unknown as Entry['properties'],
});
beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({ vaultPath: '/vault', entriesVault: '/vault', entries: [entry] });
});
it('opens a preview through the inlet, exposes mappings, and writes only on Import', async () => {
  const close = vi.fn();
  vi.mocked(importIcs)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ batchId: '', files: [] });
  render(<ImportInlet input={input} onClose={close} />);
  expect(screen.getByText('Paris meeting')).toBeTruthy();
  expect(screen.getByLabelText('Calendar preview').textContent).toContain('09:00:00+02:00');
  expect(importIcs).not.toHaveBeenCalled();
  const location = screen.getByRole('button', { name: 'Calendar location property' });
  expect(optionLabels(location)).toEqual(['Keep in page text', 'Venue']);
  chooseOption(location, 'Venue');
  expect(location.getAttribute('data-value')).toBe('venue');
  fireEvent.click(screen.getByTestId('ics-import-submit'));
  await waitFor(() => expect(importIcs).toHaveBeenCalledOnce());
  expect(vi.mocked(importIcs).mock.calls[0][1]).toMatchObject({
    type: 'Gathering',
    location: 'venue',
  });
  expect(close).not.toHaveBeenCalled();
  await waitFor(() =>
    expect((screen.getByTestId('ics-import-submit') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByTestId('ics-import-submit'));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
it('explains a missing dated database and Cancel writes nothing', () => {
  useVaultStore.setState({ entries: [] });
  const close = vi.fn();
  render(<ImportInlet input={input} onClose={close} />);
  expect(screen.getByRole('alert').textContent).toContain('No database has a date property');
  expect((screen.getByTestId('ics-import-submit') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledOnce();
  expect(importIcs).not.toHaveBeenCalled();
});
it('retires the file picker read through a vault round trip', async () => {
  render(<IcsImportDialog onClose={vi.fn()} />);
  let resolve!: (value: ArrayBuffer) => void;
  fireEvent.change(screen.getByTestId('ics-import-file'), {
    target: {
      files: [
        {
          name: 'team.ics',
          size: 300,
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((done) => {
              resolve = done;
            }),
        },
      ],
    },
  });
  await act(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/vault' });
    resolve(new TextEncoder().encode(input.content).buffer);
  });
  expect(screen.queryByText('Paris meeting')).toBeNull();
  expect(importIcs).not.toHaveBeenCalled();
});
