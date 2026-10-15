import { useEffect, useRef } from 'react';
import { attachRun } from '@/agent/agentIpc';
import type { RunRecord } from '@/agent/runs';
import type { AgentEvent } from '@/agent/types';
import { isWriteTool } from '@/engine/tools';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** What the host knows about one chat run it follows. */
interface Followed {
  /** The run it is attached to; a record that moves to another run (a
   * card's resume) is followed again. */
  run: number;
  detach: (() => void) | null;
  /** A write tool started, or the journal could not say (a gap, or no
   * journal at all), which counts as written. */
  written: boolean;
  /** Calls the run deferred that have not come back, and whether its own
   * gate raised a card for one (M57.1). */
  deferred: Set<string>;
  carded: boolean;
  settled: boolean;
}

/**
 * The one place a chat turn's end touches the vault (M57.6).
 *
 * A turn outlives its panel: closing the assistant, switching threads and
 * New conversation detach from a running turn instead of stopping it. So
 * what a finished turn does cannot live in the panel's hook, or a turn that
 * ends while nobody watches would never do it, and one watched twice would
 * do it twice. This host renders nothing and is mounted for the app's life.
 * It follows every chat run in the registry that has a child and an attach
 * key, through the run's journal from its first event, so a run that ended
 * before the host attached is settled from what it said. At Done it ends the
 * run's record, and a run that wrote rescans, exactly once. Its commit is not
 * made here: Rust commits exactly what each run wrote before its Done
 * (M58.3, `git/changeset.rs`), whether or not a panel was watching.
 *
 * Writes are known from the tool manifest (M54.2, `isWriteTool`). A gap in
 * the journal or no journal at all counts as written: a missed rescan leaves
 * the vault stale, a spare one costs nothing.
 *
 * A run that stopped on a card (M57.1) has ended and its turn has not: its
 * record ends, so the status bar reads idle while the card waits, and what
 * it wrote carries to the run that resumes it, whose Done settles the turn
 * once. A background job's run is the job runner's, and is left alone.
 */
export function ChatTurnsHost() {
  const runs = useUiStore((s) => s.runs);
  const endRun = useUiStore((s) => s.endRun);
  const rescan = useVaultStore((s) => s.rescan);
  // The latest of each, for an event that lands after a render.
  const latest = useRef({ rescan, endRun });
  latest.current = { rescan, endRun };
  const followed = useRef(new Map<string, Followed>());
  // What a run that stopped on a card wrote, by conversation, for the run
  // that resumes it.
  const carried = useRef(new Map<string, boolean>());

  useEffect(() => {
    const live = new Map<string, RunRecord>();
    for (const record of runs) {
      if (record.owner === 'chat' && record.run !== null && record.attach !== undefined) {
        live.set(record.id, record);
      }
    }
    // A record that vanished, or moved to another run, lets go.
    for (const [id, follow] of followed.current) {
      const record = live.get(id);
      if (record === undefined || record.run !== follow.run) {
        follow.detach?.();
        followed.current.delete(id);
      }
    }
    for (const record of live.values()) {
      if (followed.current.has(record.id) || record.run === null || record.attach === undefined) {
        continue;
      }
      const conversation = record.conversationId;
      const inherited = conversation !== null && carried.current.get(conversation) === true;
      if (conversation !== null) carried.current.delete(conversation);
      const follow: Followed = {
        run: record.run,
        detach: null,
        written: inherited,
        deferred: new Set(),
        carded: false,
        settled: false,
      };
      followed.current.set(record.id, follow);

      const settle = (atDone: boolean) => {
        if (follow.settled) return;
        follow.settled = true;
        follow.detach?.();
        follow.detach = null;
        const { endRun: end, rescan: scan } = latest.current;
        end(record.id);
        // Stopped on a card: the turn goes on in the resume, which settles it.
        if (atDone && follow.carded && follow.deferred.size > 0) {
          if (conversation !== null) carried.current.set(conversation, follow.written);
          return;
        }
        if (!follow.written) return;
        void scan();
      };
      const onEvent = (event: AgentEvent) => {
        if (follow.settled) return;
        switch (event.kind) {
          case 'ToolStart':
            if (isWriteTool(event.tool_name)) follow.written = true;
            return;
          case 'Interaction':
            follow.carded = true;
            return;
          case 'ToolDeferred':
            follow.deferred.add(event.tool_id);
            return;
          case 'ToolDone':
            follow.deferred.delete(event.tool_id);
            return;
          case 'Done':
            settle(true);
            return;
          default:
            return;
        }
      };
      void attachRun({ run: record.run, attach: record.attach }, 0, onEvent, (state) => {
        if (state !== 'held') follow.written = true;
      })
        .then((attached) => {
          if (attached.state === 'unknown') {
            // Nothing held for it: long finished, or never journaled. It is
            // settled now, as a run that may have written.
            settle(false);
            return;
          }
          if (follow.settled || followed.current.get(record.id) !== follow) attached.detach();
          else follow.detach = attached.detach;
        })
        .catch(() => undefined);
    }
  }, [runs]);

  // Unmounting lets go of every run; the records stay for the next mount.
  useEffect(() => {
    const all = followed.current;
    return () => {
      for (const follow of all.values()) follow.detach?.();
      all.clear();
    };
  }, []);

  return null;
}
