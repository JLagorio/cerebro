import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useVaultStore } from '@/stores/vaultStore';
import { CsvImportDialog } from './CsvImportDialog';

vi.mock('./csvActions', async (original) => ({
  ...(await original<typeof import('./csvActions')>()),
  importCsv: vi.fn(),
}));
import { importCsv } from './csvActions';
const choose = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  fireEvent.change(screen.getByTestId('csv-file-input'), {
    target: {
      files: [{ name: 'books.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer }],
    },
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  useVaultStore.setState({ entries: [], vaultPath: '/demo-vault', entriesVault: '/demo-vault' });
});

describe('CSV import preview', () => {
  it('stages name, title and kinds without writing, and closes only on success', async () => {
    const close = vi.fn();
    vi.mocked(importCsv).mockResolvedValueOnce(null).mockResolvedValueOnce('Books');
    render(<CsvImportDialog onClose={close} />);
    expect((screen.getByTestId('csv-import-submit') as HTMLButtonElement).disabled).toBe(true);
    choose('Title,Pages,Read\nDune,412,true\nFoundation,255,false\nSolaris,204,true');
    await screen.findByText('3 records');
    expect((screen.getByRole('textbox', { name: 'Database name' }) as HTMLInputElement).value).toBe(
      'Books',
    );
    expect(
      (screen.getByRole('combobox', { name: 'Kind for Pages' }) as HTMLSelectElement).value,
    ).toBe('number');
    expect(importCsv).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('csv-import-submit'));
    await waitFor(() => expect(importCsv).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((screen.getByTestId('csv-import-submit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('csv-import-submit'));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it('shows malformed rows and prevents any write', async () => {
    render(<CsvImportDialog onClose={vi.fn()} />);
    choose('Title,Pages\nDune,412\nBad,2,extra');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Row 3 has more values than the header.',
    );
    expect((screen.getByTestId('csv-import-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(importCsv).not.toHaveBeenCalled();
  });
});
