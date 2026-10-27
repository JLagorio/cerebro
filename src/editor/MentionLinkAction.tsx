import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { finishMentionLink, type SourceOpenRecord } from '@/app/sourceOpen';
import type { PaneId } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { insertMentionLink, type MentionLinkOutcome } from './mentionLink';
import type { CerebroEditor } from './MarkdownEditor';

const words: Record<'pending' | MentionLinkOutcome, string> = {
  pending: 'Inserting link…',
  applied: 'Mention linked.',
  changed: 'The page or target changed. Search mentions again before linking.',
  unsupported: 'This passage does not support automatic link insertion.',
  cancelled: 'Link insertion cancelled.',
  unavailable: 'The link could not be saved. Search mentions again to retry.',
};

/** UI for one explicit intent, mounted by the actual source editor. The
 * capture comes from its retained owner; the result never supplies authority. */
export function MentionLinkAction({
  request,
  owner,
  capture,
}: {
  request: SourceOpenRecord;
  owner: PaneId | 'peek';
  capture: () => { editor: CerebroEditor; stillCurrent: () => boolean } | null;
}) {
  const intent = request.mentionLink;
  const busy = useRef(false);
  const mounted = useRef(false);
  const [local, setLocal] = useState<MentionLinkOutcome | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!intent) return null;
  const status = local ?? intent.status;
  const finish = (outcome: MentionLinkOutcome) => {
    finishMentionLink(request, owner, outcome);
    if (mounted.current) setLocal(outcome);
  };
  const insert = async () => {
    if (busy.current || status !== undefined) return;
    busy.current = true;
    const captured = capture();
    if (!captured) {
      finish('unsupported');
      return;
    }
    finishMentionLink(request, owner, 'pending');
    const outcome = await insertMentionLink({
      ...captured,
      vault: request.openedVaultPath,
      locator: request.locator,
      targetPath: intent.targetPath,
      targetHash: intent.targetHash,
      stillCurrent: () => mounted.current && captured.stillCurrent(),
    });
    finish(outcome);
  };
  const title = useVaultStore
    .getState()
    .entries.find((entry) => entry.path === intent.targetPath)?.title;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {status !== undefined ? (
        <span>{words[status]}</span>
      ) : request.status === 'revealed' ? (
        <>
          <span>
            Link “{request.locator.quote}” to “{title ?? intent.targetPath}”.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void insert()}>
            Insert link
          </Button>
          <Button size="sm" variant="ghost" onClick={() => finish('cancelled')}>
            Cancel link
          </Button>
        </>
      ) : request.status !== undefined ? (
        <span>Link insertion needs an unchanged, supported source passage.</span>
      ) : null}
    </span>
  );
}
