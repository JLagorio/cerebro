import { memo } from 'react';
import { Item, ItemContent, ItemHeader, ItemTitle } from '@/components/ai/Item';
import { MessageToolbar } from '@/components/ai/Message';
import { Button } from '@/components/ui/Button';
import { TurnChangeset } from '@/agent/TurnChangeset';
import { TurnError } from '@/agent/TurnError';
import { NativeRecoveryHistory } from '@/agent/NativeRecoveryHistory';
import type { NativeRecoveryRoot } from '@/agent/types';
import type { RunChangeset } from '@/engine/changeset';

/** Recorded facts and an optional original native read; never repeat authority. */
export const RecoverySummary = memo(function RecoverySummary({
  question,
  error,
  nativeRoot = null,
  changesets = [],
  onOpenPath,
  onViewDiff,
  onClose,
}: {
  question: string | null;
  nativeRoot?: NativeRecoveryRoot | null;
  error: string;
  changesets?: readonly RunChangeset[];
  onOpenPath: (path: string) => void;
  onViewDiff?: (path: string, commit: string) => void;
  onClose: () => void;
}) {
  return (
    <Item
      role="region"
      aria-label="Review what happened"
      variant="outline"
      size="sm"
      className="mt-3 min-w-0 max-w-full flex-col items-stretch"
    >
      <ItemHeader className="flex flex-wrap items-center justify-between gap-2">
        <ItemTitle>This reply stopped.</ItemTitle>
        <Button size="sm" variant="ghost" tabIndex={0} onClick={onClose}>
          Close
        </Button>
      </ItemHeader>
      <ItemContent className="min-w-0 gap-3">
        <p className="m-0 text-sm text-n-700">
          Some actions may already have happened. The records shown here may be incomplete.
        </p>
        <div className="min-w-0">
          <h3 className="m-0 mb-1 text-sm font-medium text-n-800">Question</h3>
          <p className="m-0 whitespace-pre-wrap text-sm text-n-700 [overflow-wrap:anywhere]">
            {question ?? 'The question was not recorded for this reply.'}
          </p>
          {question !== null && question.trim() !== '' && (
            <MessageToolbar aria-label="Question actions" copy={question} />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="m-0 mb-1 text-sm font-medium text-n-800">What was reported</h3>
          <TurnError error={error} onOpenPath={onOpenPath} />
        </div>
        <div className="min-w-0">
          <h3 className="m-0 mb-1 text-sm font-medium text-n-800">Recorded file changes</h3>
          {changesets.length === 0 ? (
            <p className="m-0 text-sm text-n-600">
              File-change receipts are not available for this reply.
            </p>
          ) : (
            <TurnChangeset
              changesets={changesets}
              onOpenPath={onOpenPath}
              onViewDiff={onViewDiff}
            />
          )}
          <p className="m-0 mt-1 text-xs text-n-600">
            File-change receipts do not cover every action.
          </p>
        </div>
        <NativeRecoveryHistory root={nativeRoot} />
        <p className="m-0 text-sm text-n-600">
          Sending this question again from here isn’t available yet.
        </p>
      </ItemContent>
    </Item>
  );
});
