// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookFor } from '@/workspace/fileIcons';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  type AttachmentData,
} from './Attachment';

/**
 * Attachment (M91.8): a file's kind as its icon, an image's thumbnail only
 * as its caller draws it (FileThumb, CV-61; the element reads no store,
 * CV-64), its name, and a remove button named for it.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REPORT: AttachmentData = {
  id: 'a1',
  label: 'report.pdf',
  path: 'files/report.pdf',
  rootId: '0',
  description: 'PDF · 2.4 MB',
};

describe('Attachment', () => {
  it('draws its kind, its name and a remove button named for it', () => {
    const onRemove = vi.fn();
    render(
      <Attachments aria-label="Attached files">
        <Attachment data={REPORT} onRemove={onRemove} />
      </Attachments>,
    );
    const list = screen.getByRole('list', { name: 'Attached files' });
    const item = within(list).getByRole('listitem');
    expect(item.dataset.state).toBe('done');
    const preview = item.querySelector('[data-slot="attachment-preview"]') as HTMLElement;
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect(preview.dataset.kind).toBe('pdf');
    expect(preview.querySelector('svg')?.getAttribute('data-icon')).toBe(
      lookFor('files/report.pdf', false).icon,
    );
    expect(within(item).getByText('report.pdf')).toBeTruthy();
    expect(within(item).getByText('PDF · 2.4 MB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('draws an image in a root through the thumbnail it is handed, and never an img of its own', () => {
    const thumbnail = vi.fn((file: { rootId: string; path: string }, icon: ReactNode) => (
      <span data-testid="thumb" data-path={file.path} data-root={file.rootId}>
        {icon}
      </span>
    ));
    const image = { id: 'p', label: 'diagram.png', path: 'assets/diagram.png', rootId: '0' };
    render(
      <>
        <Attachment data={image}>
          <AttachmentPreview thumbnail={thumbnail} />
        </Attachment>
        <Attachment data={REPORT}>
          <AttachmentPreview thumbnail={thumbnail} />
        </Attachment>
        <Attachment data={image} data-testid="default" />
      </>,
    );
    const thumb = screen.getByTestId('thumb');
    expect(thumb.dataset.path).toBe('assets/diagram.png');
    expect(thumb.dataset.root).toBe('0');
    // Only the image asks for one, and the icon is its fallback.
    expect(thumbnail).toHaveBeenCalledOnce();
    expect(thumb.querySelector('svg')).toBeTruthy();
    // Without a thumbnail, the image's kind icon.
    expect(
      screen.getByTestId('default').querySelector('[data-slot="attachment-preview"] svg'),
    ).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('draws an image with no root, or a file with no path, as its kind’s icon', () => {
    render(
      <>
        <Attachment data={{ id: 'p', label: 'pasted.png' }} data-testid="pasted" />
        <Attachment data={{ id: 'n', label: 'notes', kind: 'markdown' }} data-testid="named" />
      </>,
    );
    expect(screen.queryByTestId('file-thumb')).toBeNull();
    const pasted = screen.getByTestId('pasted').querySelector('[data-slot="attachment-preview"]');
    expect(pasted?.getAttribute('data-kind')).toBe('image');
    expect(pasted?.querySelector('svg')).toBeTruthy();
    expect(
      screen
        .getByTestId('named')
        .querySelector('[data-slot="attachment-preview"]')
        ?.getAttribute('data-kind'),
    ).toBe('markdown');
    // Nothing to remove with: no button.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shimmers its name on the way in, and keeps a failure’s reason in words', () => {
    const { rerender } = render(<Attachment data={REPORT} state="uploading" data-testid="chip" />);
    expect(screen.getByText('report.pdf').classList.contains('cb-ai-shimmer')).toBe(true);
    rerender(
      <Attachment
        data={{ ...REPORT, description: 'Too large to attach' }}
        state="error"
        data-testid="chip"
      />,
    );
    expect(screen.getByTestId('chip').dataset.state).toBe('error');
    expect(screen.getByText('report.pdf').classList.contains('cb-ai-shimmer')).toBe(false);
    expect(screen.getByText('Too large to attach')).toBeTruthy();
  });

  it('composes its parts, and a remove button can say better', () => {
    const onRemove = vi.fn();
    render(
      <Attachment data={REPORT} onRemove={onRemove} size="sm" data-testid="chip">
        <AttachmentPreview />
        <AttachmentInfo showDescription={false} />
        <AttachmentRemove label="Take report.pdf off this message" />
      </Attachment>,
    );
    expect(screen.getByTestId('chip').dataset.size).toBe('sm');
    expect(screen.queryByText('PDF · 2.4 MB')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take report.pdf off this message' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('is not a list item outside a list, and says where a part must sit', () => {
    render(<Attachment data={REPORT} data-testid="alone" />);
    expect(screen.getByTestId('alone').getAttribute('role')).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<AttachmentInfo />)).toThrow(
      'AttachmentInfo must sit inside an Attachment',
    );
  });
});
