import { describe, expect, it } from 'vitest';
import { checkpointMessage } from '@/git/useGit';
import type { ModifiedFile } from '@/engine/git';

const file = (path: string): ModifiedFile => ({ path, status: 'modified', staged: false });

describe('checkpointMessage', () => {
  it('names the note when there is only one', () => {
    expect(checkpointMessage([file('projects/atlas/items/fld-1.md')])).toBe('Update fld-1');
  });

  it('names the folder when the changes share one', () => {
    expect(checkpointMessage([file('knowledge/a.md'), file('knowledge/b.md')])).toBe(
      'Update 2 notes in knowledge',
    );
  });

  it('falls back to a count across folders', () => {
    expect(checkpointMessage([file('knowledge/a.md'), file('projects/b.md')])).toBe(
      'Update 2 notes',
    );
  });
});
