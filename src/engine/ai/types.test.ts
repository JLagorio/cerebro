import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '@/agent/transcriptRows';
import { todoItemsFromWire, type SourceRef, type StepStatus, type WireTodo } from './types';

/** True only when A and B are the same union; `pnpm typecheck` fails the
 * assignment below the moment the two word lists drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the shapes', () => {
  it('keeps the step words equal to the transcript rows’ tool statuses', () => {
    const same: Same<StepStatus, ToolStatus> = true;
    expect(same).toBe(true);
  });

  it('narrows a source to the field its kind carries', () => {
    const where = (source: SourceRef): string => (source.kind === 'url' ? source.url : source.path);
    expect(where({ kind: 'url', url: 'https://example.com/', via: 'search' })).toBe(
      'https://example.com/',
    );
    expect(where({ kind: 'vault', path: 'notes/a.md', via: 'read' })).toBe('notes/a.md');
  });
});

describe('todoItemsFromWire', () => {
  it('reads snake_case todos as TodoItems', () => {
    expect(
      todoItemsFromWire([
        { content: 'Write tests', status: 'in_progress', active_form: 'Writing tests' },
        { content: 'Ship', status: 'pending' },
      ]),
    ).toEqual([
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship', status: 'pending' },
    ]);
  });

  it('drops an entry it cannot read rather than guess at it', () => {
    const stored = [
      { content: 'Keep', status: 'completed' },
      { content: 3, status: 'pending' },
      { content: 'No status' },
      null,
    ] as unknown as WireTodo[];
    expect(todoItemsFromWire(stored)).toEqual([{ content: 'Keep', status: 'completed' }]);
  });
});
