import { Button } from '@/components/ui/Button';
export function CreationDraftRecovery({
  pending,
  occupied = false,
  onResume,
  onDiscard,
}: {
  pending: boolean;
  occupied?: boolean;
  onResume: () => void;
  onDiscard: () => void;
}) {
  return (
    <section aria-label="Session draft" className="flex flex-col gap-3">
      <p className="m-0 text-sm">
        {occupied
          ? 'This draft is open in another composer. Resume after it closes.'
          : pending
            ? 'Creating… Your request is still awaiting acknowledgement.'
            : 'An unfinished draft is available in this session.'}
      </p>
      <p className="m-0 text-xs text-n-500">
        Draft recovery lasts for this session, until the app closes.
      </p>
      <div className="flex gap-2">
        <Button onClick={onResume}>Resume</Button>
        <Button disabled={pending || occupied} onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </section>
  );
}
