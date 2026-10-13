import { describe, expect, it } from 'vitest';
import { refusalText } from './refusal';

describe('refusalText (M49.6)', () => {
  it('drops a leading policy code and keeps the sentence', () => {
    expect(refusalText(new Error('projection_disk_changed: knowledge/a.md changed on disk'))).toBe(
      'knowledge/a.md changed on disk',
    );
    expect(refusalText('reconciliation_suspended: capture is stopped')).toBe('capture is stopped');
  });

  it('leaves prose that merely contains a colon alone', () => {
    const prose = 'provenance forgery: the verified stamp changed out of band — refused';
    expect(refusalText(new Error(prose))).toBe(prose);
  });
});
