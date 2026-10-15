import { readAddress } from '@/engine/agents';
import type { Entry } from '@/engine/types';
import { flushOpenPages } from '@/editor/openPages';
import { useUiStore } from '@/stores/uiStore';
import { startThreadTurn } from './agentIpc';

/**
 * Ask the agent a person's comment names (M70.4).
 *
 * `text` is the comment the person just posted, as `message` in `thread` on
 * `page`. A comment that names nobody does nothing: no reply infers a
 * follow-up. One that names an `@handle` no agent answers to says so, and
 * asks nobody. Otherwise the open pages' saves land first, so the turn reads
 * what is on screen, and Rust runs one turn of that agent, whose answer
 * lands in the same thread (`start_thread_turn`).
 *
 * The comment composers' successful posts are the only callers
 * (`usePageComments`): loading threads or hearing that they changed never
 * asks anyone, and an agent's own comments never reach here. Never throws
 * (CV-03): a refusal is toasted once, in Rust's words.
 */
export async function askAgentInThread({
  vault,
  page,
  thread,
  message,
  text,
  entries,
}: {
  vault: string;
  page: string;
  thread: string;
  message: string;
  text: string;
  entries: Entry[];
}): Promise<void> {
  const address = readAddress(text, entries);
  if (address === null) return;
  const toast = useUiStore.getState().toast;
  if (address.agent === null) {
    toast(`No agent answers to @${address.handle}, so nobody was asked.`);
    return;
  }
  try {
    await flushOpenPages();
    await startThreadTurn(vault, { page, thread, message, handle: address.handle });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}
