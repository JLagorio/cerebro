import { useEffect } from 'react';
import { markLeft } from '@/app/quit';

/**
 * What a quit shows once the shell is gone (M55.10). App swaps the shell for
 * this screen, so every page under it runs its own leave path first; React
 * runs those cleanups before this mount effect, which tells the quit the
 * leave is done.
 */
export function QuitScreen() {
  useEffect(() => {
    markLeft();
  }, []);
  return (
    <div
      role="status"
      data-testid="quit-screen"
      className="flex h-screen items-center justify-center bg-n-0 text-sm text-n-600"
    >
      Saving…
    </div>
  );
}
