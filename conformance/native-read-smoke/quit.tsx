// M93 controlled measurement fixture. This is deliberately not an editor journey.
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { quitDeps, useQuitHost, useQuitting, type QuitDeps } from '../../src/app/quit';
import { QuitScreen } from '../../src/app/QuitScreen';
import { retainDocumentOwner, registerSaveParticipant } from '../../src/editor/openPages';
import type { DocumentOwner } from '../../src/editor/documentOwner';
import { sha256Hex } from '../../src/lib/sha256';

type Case =
  | 'failed-owner'
  | 'pending-owner'
  | 'late-unresolved'
  | 'late-ipc-150'
  | 'late-ipc-350'
  | 'second-quit'
  | 'expired-second-quit'
  | 'hung-webview';
type Bootstrap = { profile: 'quit-timing'; case: Case; nativePid: number };
type Stage =
  | 'flush'
  | 'settle-first'
  | 'leave'
  | 'settle-second'
  | 'writer'
  | 'retry'
  | 'cleanup'
  | 'heartbeat'
  | 'shell-mounted';
const DRAFT = 'M93 controlled retained draft\n';
const CLEAN = 'M93 controlled clean source\n';
const cases: Case[] = [
  'failed-owner',
  'pending-owner',
  'late-unresolved',
  'late-ipc-150',
  'late-ipc-350',
  'second-quit',
  'expired-second-quit',
  'hung-webview',
];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function nativeInvoke(probe: object): Promise<unknown> {
  const native = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke: (name: string, args: object) => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__;
  if (!native) throw new Error('Native fixture refuses browser/mock execution');
  return native.invoke('capture_native_reads', { probe });
}
function snapshot(owner: DocumentOwner) {
  const s = owner.snapshot();
  return {
    latestDraft: s.latestDraft,
    generation: s.generation,
    acknowledgedGeneration: s.acknowledgedGeneration,
    inFlightGeneration: s.inFlightGeneration,
    failed: s.failure !== null,
    payloadSha256: sha256Hex(s.latestDraft),
  };
}

const lateIpc = (scenario: Case) => scenario === 'late-ipc-150' || scenario === 'late-ipc-350';
type Phase = 'flush' | 'settle-first' | 'leave' | 'settle-second';
type CompactEvent = [number, number, string, number, ...unknown[]];

/** One closed measurement; owns evidence, never the document or a native deadline. */
class LateWindowMeasurement {
  private binding: string | null = null;
  private started = false;
  private cancelled = false;
  private ending = false;
  private unresolved: boolean | null = null;
  private mounts = 0;
  private cleanups = 0;
  private settles = 0;
  private broken: string | null = null;
  private readonly events: CompactEvent[] = [];
  private readonly snapshots: ReturnType<typeof snapshot>[] = [];
  private readonly completed: Phase[] = [];
  private restore!: () => void;
  private readonly restored = new Promise<void>((resolve) => {
    this.restore = resolve;
  });
  private readonly ownerKey: DocumentOwner['key'];

  constructor(private readonly owner: DocumentOwner) {
    this.ownerKey = { ...owner.key };
  }

  private record(tag: string, values: unknown[] = [], body?: string): void {
    if (this.events.length >= 192) {
      this.broken = 'event-cap';
      return;
    }
    const state = snapshot(this.owner);
    if (body !== undefined) {
      state.latestDraft = body;
      state.payloadSha256 = sha256Hex(body);
    }
    const encoded = JSON.stringify(state);
    let index = this.snapshots.findIndex((value) => JSON.stringify(value) === encoded);
    if (index < 0) {
      index = this.snapshots.length;
      this.snapshots.push(state);
    }
    this.events.push([this.events.length, performance.now(), tag, index, ...values]);
  }

  mounted(owner: DocumentOwner): void {
    if (owner !== this.owner) this.broken = 'replacement-owner';
    this.mounts += 1;
    this.record('mount', [this.mounts]);
    if (this.ending && this.mounts === 2 && this.cleanups === 1) this.restore();
    else if (this.mounts > 1) this.broken = 'unexpected-mount';
  }

  cleanup(owner: DocumentOwner): void {
    if (owner !== this.owner) this.broken = 'replacement-owner';
    this.cleanups += 1;
    if (this.cleanups !== 1) this.broken = 'repeated-cleanup';
    this.record('cleanup');
  }

  writer(body: string): void {
    this.record('writer', [], body);
  }

  check(name: 'hasUnresolved' | 'pageWriteFailures', value: boolean | number): void {
    if (name === 'hasUnresolved' && typeof value === 'boolean') this.unresolved = value;
    this.record('check', [name, value]);
  }

  flush(budget: number): ReturnType<QuitDeps['flushOpenPages']> {
    this.settles = 0;
    return this.stage('flush', budget, () => quitDeps.flushOpenPages(budget));
  }

  settle(budget: number): ReturnType<QuitDeps['settlePageWrites']> {
    const name = ++this.settles === 1 ? 'settle-first' : 'settle-second';
    return this.stage(name, budget, () => quitDeps.settlePageWrites(budget));
  }

  async stage<T>(name: Phase, budget: number, operation: () => Promise<T>): Promise<T> {
    this.record('enter', [name, budget]);
    try {
      const value = await operation();
      this.record('complete', [
        name,
        budget,
        { kind: 'fulfilled', value: value === undefined ? null : value },
      ]);
      this.completed.push(name);
      return value;
    } catch (error) {
      this.record('complete', [name, budget, { kind: 'rejected', code: 'operation-rejected' }]);
      throw error;
    }
  }

  endLeaving(): void {
    this.ending = true;
    quitDeps.endLeaving();
    this.record('end', [this.unresolved]);
  }

  private readBinding(reply: unknown): string {
    if (reply === null || typeof reply !== 'object') throw new Error('Native binding missing');
    const value = (reply as { binding?: unknown }).binding;
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
      throw new Error('Native binding invalid');
    }
    return value;
  }

  async bind(): Promise<boolean> {
    // The coordinator's later Idle probe is native-only, after this real cancel.
    if (this.cancelled) return false;
    if (this.started) throw new Error('Repeated measurement request');
    this.started = true;
    this.binding = this.readBinding(await nativeInvoke({ kind: 'bind-attempt' }));
    return true;
  }

  private async sendBatch(): Promise<void> {
    if (JSON.stringify(this.owner.key) !== JSON.stringify(this.ownerKey)) {
      this.broken = 'owner-key-changed';
    }
    const probe = {
      kind: 'phase-batch',
      binding: this.binding,
      format: 1,
      ownerKey: this.ownerKey,
      ownerInstance: 'retained-1',
      snapshots: this.snapshots,
      events: this.events,
      broken: this.broken,
    };
    // The native side expands compact records; it must never log this whole batch
    // as a trace row. Keep the existing 2048-byte bound even on this input.
    if (new TextEncoder().encode(JSON.stringify(probe)).byteLength > 2048) {
      this.broken = 'batch-byte-cap';
      await nativeInvoke({
        kind: 'phase-batch',
        binding: this.binding,
        format: 1,
        ownerKey: this.ownerKey,
        ownerInstance: 'retained-1',
        snapshots: [],
        events: [],
        broken: this.broken,
      });
      throw new Error('Measurement batch exceeds native row bound');
    }
    await nativeInvoke(probe);
  }

  async refuse(): Promise<void> {
    this.broken ??= 'measurement-refused';
    // Best-effort failure evidence is never permission to cancel or finish.
    await this.sendBatch().catch(() => undefined);
  }

  async cancel(): Promise<void> {
    this.record('cancel');
    if (
      this.completed.join(',') !== 'flush,settle-first,leave,settle-second' ||
      this.cleanups !== 1 ||
      !this.ending ||
      this.binding === null ||
      this.broken !== null
    ) {
      await this.refuse();
      throw new Error('Real late cleanup path incomplete');
    }
    await this.restored;
    await this.sendBatch();
    if (this.broken !== null) throw new Error('Measurement evidence refused');
    const release = await nativeInvoke({ kind: 'wait-late-window', binding: this.binding });
    if (this.readBinding(release) !== this.binding)
      throw new Error('Native release binding changed');
    await quitDeps.cancelQuit();
    this.cancelled = true;
  }

  stayed(): void {
    void nativeInvoke({
      kind: 'stayed',
      binding: this.binding,
      sequence: this.events.length,
      ms: performance.now(),
      snapshot: { ...snapshot(this.owner), ownerKey: this.ownerKey, ownerInstance: 'retained-1' },
    }).catch(() => undefined);
  }
}

function LateWindowFixture({
  owner,
  measurement,
}: {
  owner: DocumentOwner;
  measurement: LateWindowMeasurement;
}) {
  const leaving = useQuitting();
  const deps = useMemo<QuitDeps>(() => {
    return {
      ...quitDeps,
      flushOpenPages: (budget) => measurement.flush(budget),
      settlePageWrites: (budget) => measurement.settle(budget),
      beginLeaving: (budget) =>
        measurement.stage('leave', budget, () => quitDeps.beginLeaving(budget)),
      hasUnresolved: () => {
        const value = quitDeps.hasUnresolved();
        measurement.check('hasUnresolved', value);
        return value;
      },
      pageWriteFailures: () => {
        const value = quitDeps.pageWriteFailures();
        measurement.check('pageWriteFailures', value);
        return value;
      },
      endLeaving: () => measurement.endLeaving(),
      cancelQuit: () => measurement.cancel(),
      toast: () => measurement.stayed(),
      listenQuitRequested: async (handler) => {
        const stop = await quitDeps.listenQuitRequested((request) => {
          void measurement
            .bind()
            .then((bound) => {
              if (bound) handler(request);
            })
            .catch(() => measurement.refuse());
        });
        await nativeInvoke({ kind: 'ready' });
        return stop;
      },
    };
  }, [measurement]);
  useQuitHost(deps);
  return leaving ? <QuitScreen /> : <Shell owner={owner} late measurement={measurement} />;
}

function Shell({
  owner,
  late,
  measurement,
}: {
  owner: DocumentOwner;
  late: boolean;
  measurement?: LateWindowMeasurement;
}) {
  const [state, setState] = useState(() => owner.snapshot());
  useEffect(() => owner.subscribe(() => setState(owner.snapshot())), [owner]);
  useEffect(() => {
    if (measurement) {
      measurement.mounted(owner);
      return;
    }
    void nativeInvoke({
      kind: 'stage',
      stage: 'shell-mounted',
      edge: 'complete',
      ms: performance.now(),
      snapshot: snapshot(owner),
    });
  }, [owner, measurement]);
  useEffect(
    () => () => {
      if (late) {
        owner.edit(DRAFT);
        if (measurement) {
          measurement.cleanup(owner);
          return;
        }
        void nativeInvoke({
          kind: 'stage',
          stage: 'cleanup',
          edge: 'complete',
          ms: performance.now(),
          snapshot: snapshot(owner),
        });
      }
    },
    [late, owner, measurement],
  );
  return (
    <main>
      <h1>Controlled native quit measurement</h1>
      <p>
        Synthetic writer and fixed latency injection. No real disk failure or native typing is
        exercised.
      </p>
      <pre>{state.latestDraft}</pre>
      <p>
        Generation {state.generation}; acknowledged {state.acknowledgedGeneration}
      </p>
    </main>
  );
}
function Fixture({ owner, scenario }: { owner: DocumentOwner; scenario: Case }) {
  const leaving = useQuitting();
  const late = scenario.startsWith('late-');
  const deps = useMemo<QuitDeps>(() => {
    let settleCount = 0;
    const stage = async <T,>(
      name: Stage,
      delay: number,
      operation: () => Promise<T>,
    ): Promise<T> => {
      await nativeInvoke({
        kind: 'stage',
        stage: name,
        edge: 'enter',
        ms: performance.now(),
        snapshot: snapshot(owner),
      });
      await sleep(delay);
      const value = await operation();
      await nativeInvoke({
        kind: 'stage',
        stage: name,
        edge: 'complete',
        ms: performance.now(),
        snapshot: snapshot(owner),
      });
      return value;
    };
    return {
      ...quitDeps,
      flushOpenPages: (ms) => {
        settleCount = 0;
        return stage('flush', late ? 2490 : 0, () => quitDeps.flushOpenPages(ms));
      },
      settlePageWrites: (ms) => {
        const name = ++settleCount === 1 ? 'settle-first' : 'settle-second';
        return stage(name, late ? 740 : 0, () => quitDeps.settlePageWrites(ms));
      },
      beginLeaving: (ms) => stage('leave', late ? 740 : 0, () => quitDeps.beginLeaving(ms)),
      toast: () => {
        void nativeInvoke({ kind: 'stayed', ms: performance.now(), snapshot: snapshot(owner) });
      },
      listenQuitRequested: async (handler) => {
        // The real IPC adapter registers Tauri's listener before native readiness.
        const stop = await quitDeps.listenQuitRequested(handler);
        await nativeInvoke({ kind: 'ready' });
        if (scenario === 'hung-webview') {
          for (let i = 0; i < 3; i++) {
            await nativeInvoke({
              kind: 'stage',
              stage: 'heartbeat',
              edge: 'complete',
              ms: performance.now(),
              snapshot: snapshot(owner),
            });
            await sleep(50);
          }
          await nativeInvoke({
            kind: 'hang-armed',
            ms: performance.now(),
            snapshot: snapshot(owner),
          });
          // Fixed controlled hang; native coordinator starts the request after 200 ms.
          setTimeout(() => {
            for (;;) {
              /* bounded by the native deadline/watchdog */
            }
          }, 0);
        }
        return stop;
      },
    };
  }, [late, owner, scenario]);
  useQuitHost(deps);
  return leaving ? <QuitScreen /> : <Shell owner={owner} late={late} />;
}
export async function mountQuitFixture(reply: Bootstrap): Promise<void> {
  if (
    reply.profile !== 'quit-timing' ||
    !cases.includes(reply.case) ||
    !Number.isInteger(reply.nativePid) ||
    reply.nativePid <= 1 ||
    !(window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
  ) {
    throw new Error('Closed native bootstrap required');
  }
  const pending = reply.case === 'pending-owner' || reply.case === 'second-quit';
  const late = reply.case.startsWith('late-');
  let measurement: LateWindowMeasurement | undefined;
  const owner: DocumentOwner = retainDocumentOwner(
    { vaultId: 'm93-controlled-vault', path: 'controlled.md', ownerId: 'm93-native-quit' },
    CLEAN,
    async (body) => {
      // Record the actual received payload, never invent a successful write acknowledgement.
      if (measurement) measurement.writer(body);
      else
        await nativeInvoke({
          kind: 'stage',
          stage: 'writer',
          edge: 'enter',
          ms: performance.now(),
          snapshot: { ...snapshot(owner), latestDraft: body, payloadSha256: sha256Hex(body) },
        });
      if (pending) return await new Promise<never>(() => {});
      throw new Error('M93 controlled writer refusal');
    },
  );
  if (lateIpc(reply.case)) measurement = new LateWindowMeasurement(owner);
  registerSaveParticipant({
    key: owner.key,
    identity: owner,
    prepare: () => undefined,
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  if (!late && reply.case !== 'hung-webview') owner.edit(DRAFT);
  if (reply.case === 'failed-owner' || reply.case === 'expired-second-quit') {
    // Ready is not admitted until real pre-existing failure and unchanged-draft Retry finish.
    await owner.flush();
    await nativeInvoke({
      kind: 'stage',
      stage: 'retry',
      edge: 'enter',
      ms: performance.now(),
      snapshot: snapshot(owner),
    });
    await owner.retry();
    await nativeInvoke({
      kind: 'stage',
      stage: 'retry',
      edge: 'complete',
      ms: performance.now(),
      snapshot: snapshot(owner),
    });
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(
    measurement ? (
      <LateWindowFixture owner={owner} measurement={measurement} />
    ) : (
      <Fixture owner={owner} scenario={reply.case} />
    ),
  );
}

// Separate explicit native managed-action profile; preserves the pinned quit mount export.
export { mountManagedActionFixture } from './managed';
