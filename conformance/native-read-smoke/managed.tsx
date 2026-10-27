// Explicit macOS fixture only: actual production card + native IPC, no browser mocks.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractionCard } from '../../src/agent/InteractionCard';
import { answerInteraction, listInteractions, readManagedActionAccess, setManagedActionAccess, stopAgent } from '../../src/agent/agentIpc';
import type { PendingInteraction, PersonAnswer } from '../../src/agent/types';
import type { WaitingCard } from '../../src/agent/useAgentChat';
import '../../src/styles/tokens/fonts.css';
import '../../src/styles/tokens/colors.css';
import '../../src/styles/tokens/typography.css';
import '../../src/styles/tokens/spacing.css';
import '../../src/styles/tokens/base.css';
type Bootstrap = { profile: 'managed-action'; scenario: 'allow' | 'stop' | 'window'; run: number; sessionId: string; vault: string; input: string };
function invoke(probe: object): Promise<unknown> {
  const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (native === undefined) throw new Error('native-required');
  return native.invoke('native_managed_action_probe', { probe });
}
const pause = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
function Fixture({ original }: { original: Bootstrap }) {
  const [waiting, setWaiting] = useState<WaitingCard | null>(null);
  const [notice, setNotice] = useState('Waiting for the original managed call…');
  // The callbacks carry only this mounted view's commands; Rust owns the wait.
  const [controls] = useState(() => ({ choose: (_run: number, _id: string) => {}, answer: (_answer: PersonAnswer) => {} }));
  useEffect(() => {
    let mounted = true; let entered = false; let stage = 'mounted-card';
    let choose!: (run: number, id: string) => void;
    let answer!: (decision: PersonAnswer) => void;
    const callbacks = { choose: (run: number, id: string) => choose(run, id), answer: (decision: PersonAnswer) => answer(decision) };
    Object.assign(controls, callbacks);
    const waitCard = async (kind: PendingInteraction['kind']) => {
      const deadline = performance.now() + 15000;
      while (mounted && performance.now() < deadline) {
        const cards = await listInteractions(original.vault);
        const card = cards.find((item) => item.kind === kind && item.run === original.run);
        if (card !== undefined) {
          if (card.tool_id !== null || card.session_id !== original.sessionId) throw new Error('card-owner');
          return card;
        }
        await pause(30);
      }
      throw new Error('card-timeout');
    };
    const clickMounted = async (label: string) => {
      await invoke({ kind: 'progress', stage: 'mount_wait' });
      // Observe the actual committed control; background WebKit need not issue
      // an animation frame. This is a bounded DOM/layout check, not paint proof.
      const button = await new Promise<HTMLButtonElement>((resolve, reject) => {
        let settled = false;
        const observer = new MutationObserver(check);
        const timer = window.setTimeout(() => finish(null), 2000);
        function finish(found: HTMLButtonElement | null) {
          if (settled) return;
          settled = true; observer.disconnect(); window.clearTimeout(timer);
          if (found === null) reject(new Error('mounted-card')); else resolve(found);
        }
        function check() {
          if (!mounted) { finish(null); return; }
          const matches = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="managed-native-fixture"] button')].filter((item) => item.textContent?.trim() === label);
          if (matches.length !== 1) return;
          const found = matches[0]!;
          if (found.isConnected && !found.disabled && found.getBoundingClientRect().width > 0 && getComputedStyle(found).visibility !== 'hidden') finish(found);
        }
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        check();
      });
      await invoke({ kind: 'progress', stage: 'mount_ready' });
      if (!mounted || !button.isConnected || button.disabled || button.getBoundingClientRect().width === 0 || getComputedStyle(button).visibility === 'hidden') throw new Error('mounted-card');
      button.click();
      await invoke({ kind: 'progress', stage: 'click_dispatched' });
    };
    void (async () => {
      if (entered) return; entered = true;
      const access = await waitCard('managed_access');
      await invoke({ kind: 'access', card_id: access.id });
      await invoke({ kind: 'progress', stage: 'access_mount_requested' });
      setWaiting({ card: access, messageId: 'original-native-fixture', answering: false, stale: null });
      const chosen = new Promise<void>((resolve, reject) => {
        choose = (run, id) => { void (async () => {
          stage = 'access-command';
          await invoke({ kind: 'progress', stage: 'access_callback' });
          if (run !== original.run || id !== access.id) throw new Error('access-owner');
          const view = await readManagedActionAccess(run);
          await invoke({ kind: 'progress', stage: 'access_read_returned' });
          if (view.accessRequestId !== id || view.accounts.length !== 1) throw new Error('access-view');
          const account = view.accounts[0]!;
          const definition = view.definitions.find((item) => item.actionId === 'github.issue.create');
          if (definition === undefined) throw new Error('access-definition');
          const result = await setManagedActionAccess(run, { expectedAccessRevision: view.accessRevision, completeRequestId: id, selections: [{ kind: 'new', selection: { connectionId: account.connectionId, accountId: account.accountId, accountRevision: account.accountRevision, revocationGeneration: account.revocationGeneration, actionId: definition.actionId, definitionDigest: definition.definitionDigest, inputScope: { kind: 'exact_canonical_input', input: original.input } } }] });
          await invoke({ kind: 'progress', stage: 'access_write_returned' });
          if (result.state !== 'changed' || !result.sourceCurrent || !result.requestClosed) throw new Error('access-commit');
          resolve();
        })().catch(reject); };
      });
      await clickMounted('Choose access'); await chosen;
      stage = 'effect-card';
      const effect = await waitCard('managed_action');
      await invoke({ kind: 'before_answer', card_id: effect.id });
      setWaiting({ card: effect, messageId: 'original-native-fixture', answering: false, stale: null });
      setNotice('The original call is held. This isolated fixture now presses its displayed control.');
      if (original.scenario === 'allow') {
        const answered = new Promise<void>((resolve, reject) => {
          answer = (decision) => { void (async () => {
            stage = 'answer-command';
            if (decision.kind !== 'allow') throw new Error('answer-kind');
            setWaiting((prior) => prior === null ? null : { ...prior, answering: true });
            const result = await answerInteraction(original.vault, effect.id, decision);
            if (!('answered' in result) || result.answered.interactionId !== effect.id || Object.keys(result).length !== 1) throw new Error('answer-owner');
            await invoke({ kind: 'answered', card_id: effect.id, answered_id: result.answered.interactionId });
            resolve();
          })().catch(reject); };
        });
        await clickMounted('Allow once'); await answered;
        stage = 'completed-result'; await invoke({ kind: 'finish' });
      } else if (original.scenario === 'stop') {
        stage = 'stop-command';
        await stopAgent(original.run);
        const late = await answerInteraction(original.vault, effect.id, { kind: 'allow' });
        await invoke({ kind: 'stopped', card_id: effect.id, refused: 'refused' in late });
        await invoke({ kind: 'finish' });
      } else {
        stage = 'window-command'; await invoke({ kind: 'destroy_window', card_id: effect.id });
      }
    })().catch(() => { if (mounted) { setNotice('Native fixture failed at ' + stage + '. Inspect the isolated report.'); void invoke({ kind: 'fail', stage }).catch(() => undefined); } });
    return () => { mounted = false; };
  }, [original, controls]);
  return <section data-testid="managed-native-fixture" style={{ maxWidth: 760, margin: '32px auto', padding: 24, background: 'var(--n-0)', color: 'var(--n-900)', fontFamily: 'var(--font-ui)' }}><h2>Isolated native managed action</h2><p role="status">{notice}</p><p>Real original publication and window commands. Fixed fake provider only; no account credential or GitHub request.</p>{waiting !== null && <InteractionCard interaction={waiting} onChooseAccess={(run, id) => controls.choose(run, id)} onAnswer={(decision) => controls.answer(decision)} />}</section>;
}
export function mountManagedActionFixture(value: Bootstrap): void {
  if (value.profile !== 'managed-action' || !['allow', 'stop', 'window'].includes(value.scenario) || !Number.isSafeInteger(value.run) || value.run < 0 || typeof value.vault !== 'string' || typeof value.sessionId !== 'string' || typeof value.input !== 'string') throw new Error('native-bootstrap');
  const host = document.createElement('div'); document.body.appendChild(host); createRoot(host).render(<Fixture original={value} />);
}
