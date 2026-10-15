import { describe, expect, it } from 'vitest';
import cases from '../../src-tauri/fixtures/attachment-names.json';
import {
  attachmentLink,
  attachmentName,
  attachmentRefusal,
  describeAttachments,
} from './attachments';
describe('attachment names and outcomes', () => {
  it('replays the shared attachment names', () => {
    for (const item of cases) {
      expect(attachmentName(item.name), item.name).toBe(item.safe);
      expect(attachmentRefusal(item.name, item.size), item.name).toBe(item.refusal);
    }
  });
  it('writes one root-anchored link and one batch summary', () => {
    expect(attachmentLink('attachments/a b.png')).toBe('/attachments/a b.png');
    const added = { path: 'attachments/a.png', reused: false };
    const reused = { ...added, reused: true };
    expect(describeAttachments([added], [])).toBe('Added 1 file to attachments/');
    expect(describeAttachments([added, added, reused], [])).toBe(
      'Added 2 files to attachments/ and reused 1 already there',
    );
    expect(describeAttachments([reused], [])).toBe('Reused 1 file already in attachments/');
    expect(describeAttachments([], ['.env is hidden', 'big.mov is over 50 MB'])).toBe(
      'Nothing added — skipped: .env is hidden; big.mov is over 50 MB',
    );
  });
});
