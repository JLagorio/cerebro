import { onAgentEvent, readManagedActionAccess, setManagedActionAccess } from './agentIpc';
import { runActionAccessBook, type AccessSession } from './managedActionAccessBook';
import type { RunActionAccessApi } from './managedActionAccessSession';

const api: RunActionAccessApi = {
  read: (run) => readManagedActionAccess(run),
  set: (run, request) => setManagedActionAccess(run, request),
};
let listening = false;

/** Presentation may detach; the app-session owner retains any actual write. */
export function openRunActionAccess(run: number, requestId: string | null): AccessSession | null {
  const session = runActionAccessBook.acquire(run, requestId, api);
  if (session !== null && !listening) {
    // One application listener outlives all sheet mounts. Only the native
    // original run/card can retire an in-flight view; closing UI never does.
    onAgentEvent((event) => {
      if (event.kind === 'InteractionClosed')
        runActionAccessBook.retire(event.run, event.interaction_id);
      else if (event.kind === 'Done') runActionAccessBook.retire(event.run);
    });
    listening = true;
  }
  return session;
}
