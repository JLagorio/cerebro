import { useEffect, useMemo, useRef, useState } from 'react';
import { Confirmation } from '@/components/ai/Confirmation';
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai/PromptInput';
import { Suggestion, Suggestions } from '@/components/ai/Suggestion';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { applyHunks, describeHunk, isUnchanged, rewriteHunks } from '@/engine/hunks';
import { argumentHint, listSkills, skillPrompt, type SkillRef } from '@/engine/skills';
import { readNote } from '@/lib/ipc';
import { askAiWorking, rewriteDecision } from '@/agent/elements/writingAsk';
import { onAgentEvent, runAgent, startedOrThrow } from '@/agent/agentIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PRESETS } from './SelectionToolbar';
import './editor.css';

/**
 * Ask AI on a selection (M17.16), and run a skill on one (M17.17).
 *
 * Selection → prompt → the passage comes back rewritten, shown against the
 * original with **Accept / Reject per hunk**. Nothing is applied until a
 * decision is made, and rejecting everything leaves the passage byte-identical
 * (engine/hunks).
 *
 * ## What it deliberately is not
 *
 * It does not stream into the buffer. `onChange` fires for programmatic edits,
 * so streaming insertion would thrash the editor's 500 ms save debounce and
 * hold the header at "Unsaved" for the whole generation — writing a
 * half-finished sentence to disk several times on the way. The rewrite is
 * assembled here and lands in one edit, which is also the only version that
 * can be rejected cleanly.
 *
 * It also does not span files. Anything multi-file escalates to the panel,
 * which has the context chips, the transcript, and the run registry; a popover
 * over one paragraph is the wrong surface to watch a five-file change from.
 *
 * ## Its elements (M91.14)
 *
 * The instruction is a Prompt Input (Enter asks, Shift+Enter is a new line),
 * the writing actions are Suggestion rows, the working line carries the AI
 * light, and the decision is a Confirmation whose body holds the hunks and
 * its answers. Its own answers, not the card's approve and deny: Retry asks
 * again and Apply writes the hunks the person kept, neither of which is a
 * yes or a no to an agent's call. Like every control here, each takes an
 * explicit `tabIndex`, without which WebKit leaves a button out of Tab.
 *
 * ## The tool policy
 *
 * A rewrite is a pure text transformation, so the run is granted NO tools at
 * all — `allowedTools: []`, which Rust honours as "narrow to nothing" (M17.8).
 * It cannot read the vault, cannot write to it, and cannot call open_note to
 * navigate you somewhere mid-edit. What it gets is the passage, in the prompt.
 */
export function AskAiPopover({
  selection,
  preset,
  onReplace,
  onClose,
}: {
  /** The exact text the user selected. */
  selection: string;
  /**
   * An instruction to run straight away, from the selection toolbar's presets
   * (M18). It goes through the same `ask()` as a typed one — a preset is a
   * pre-written instruction, never a shortcut past the decision surface.
   */
  preset?: string;
  /** Apply the decided text. Called once, with the final passage. */
  onReplace: (text: string) => void;
  onClose: () => void;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const toast = useUiStore((s) => s.toast);
  // Seeded with the preset so Retry re-runs what was actually asked, and so
  // the box shows the instruction rather than going blank on a retry.
  const [instruction, setInstruction] = useState(preset ?? '');
  const [showActions, setShowActions] = useState(false);
  const [state, setState] = useState<'asking' | 'running' | 'deciding'>(
    // Straight to 'running': the effect below fires after the first paint, and
    // starting at 'asking' would flash an empty prompt box for one frame.
    preset !== undefined && preset.trim() !== '' ? 'running' : 'asking',
  );
  const [result, setResult] = useState('');
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  // The skill a run applies, so its working line can name it.
  const [skillRun, setSkillRun] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);

  const skills = useMemo(() => listSkills(entries), [entries]);
  const rewrite = useMemo(() => rewriteHunks(selection, result), [selection, result]);
  const decision = rewriteDecision(isUnchanged(rewrite) ? 0 : rewrite.hunks.length, accepted.size);

  useEffect(() => {
    // Mounted again — React's development double mount does that — it hears
    // its run again: only an unmount for good leaves the answer unheard.
    cancelled.current = false;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      cancelled.current = true;
    };
  }, []);

  const run = (message: string, skill?: string) => {
    if (vaultPath === null || message.trim() === '') return;
    setState('running');
    setSkillRun(skill);
    setResult('');
    void (async () => {
      try {
        // Attended, no lane: never gated — startedOrThrow makes a contract
        // break visible instead of a silent no-run.
        const { run: runId } = startedOrThrow(
          await runAgent(vaultPath, {
            message,
            systemPrompt:
              "You rewrite a passage of the user's document and return ONLY the rewritten passage. " +
              'No preamble, no explanation, no code fence, no quotation marks around it. ' +
              'Preserve the markdown formatting of the original unless the instruction asks otherwise. ' +
              'If the instruction cannot be applied, return the passage unchanged.',
            sessionId: null,
            model: null,
            shell: 'off',
            connectors: false,
            attended: true,
            // No tools at all. A rewrite is a text transformation; giving it
            // the vault would let it wander, and open_note would navigate the
            // user away from the paragraph they are editing.
            allowedTools: [],
          }),
        );
        let text = '';
        const stop = onAgentEvent((event) => {
          if (cancelled.current) return;
          if (event.kind === 'TextDelta') text += event.text;
          if (event.kind === 'Result' && event.text.trim() !== '') text = event.text;
          if (event.kind === 'Error') {
            toast(event.message);
            setState('asking');
            stop();
          }
          if (event.kind === 'Done') {
            stop();
            const clean = text.trim().replace(/^```[a-z]*\n?|\n?```$/g, '');
            setResult(clean);
            // Every hunk starts ACCEPTED. The user asked for this change; the
            // default should be the thing they asked for, with rejection as
            // the correction. Starting at none makes the common case — "yes,
            // all of it" — a click per hunk.
            setAccepted(new Set(rewriteHunks(selection, clean).hunks.map((h) => h.id)));
            setState('deciding');
          }
        }, runId);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        setState('asking');
      }
    })();
  };

  const ask = (override?: string) =>
    run(
      [
        `Rewrite this passage from the user's document. Instruction: ${(override ?? instruction).trim()}`,
        '',
        'Passage:',
        selection,
      ].join('\n'),
    );

  // Whether the preset was asked: a ref, so a second mount asks nothing more.
  const presetAsked = useRef(false);
  useEffect(() => {
    // A preset arrives already decided, so the run starts on mount, with the
    // instruction shown working rather than waiting to be sent. Runs once:
    // `run` closes over state that changes during the run, and re-firing on
    // it — or on React's development double mount — would start a second one
    // mid-answer.
    if (presetAsked.current) return;
    presetAsked.current = true;
    if (preset !== undefined && preset.trim() !== '') ask(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSkill = (skill: SkillRef) => {
    if (vaultPath === null) return;
    setState('running');
    setSkillRun(skill.name);
    void (async () => {
      try {
        const raw = await readNote(vaultPath, skill.path);
        // M17.17: the same record, the same body, a second entry point. The
        // skill is told the passage IS the input, so a skill written for the
        // chat works here without being rewritten for it.
        run(
          `${skillPrompt(skill, raw, selection)}\n\nApply it to this passage:\n${selection}`,
          skill.name,
        );
      } catch {
        toast("Couldn't read the skill");
        setState('asking');
      }
    })();
  };

  const toggle = (id: number) =>
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      data-testid="ask-ai"
      role="dialog"
      aria-label="Ask AI about the selection"
      className="max-h-[var(--popover-available-height,calc(100dvh-16px))] w-[420px] max-w-[var(--popover-available-width,calc(100vw-16px))] overflow-y-auto rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {state !== 'deciding' && (
        <>
          <PromptInput
            // An empty instruction asks for nothing.
            onSubmit={() => {
              if (instruction.trim() !== '') ask();
            }}
            disabled={state === 'running'}
            className="cb-ask-ai-field"
          >
            <Icon name="sparkles" size={13} color="var(--synapse-500)" />
            <PromptInputBody>
              <PromptInputTextarea
                ref={inputRef}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                aria-label="What should the assistant do with this passage?"
                placeholder={state === 'running' ? 'Working…' : 'Make it shorter, fix the tone…'}
              />
            </PromptInputBody>
            {/* Disabled while empty or working, and so out of the Tab order:
                from the field, Tab reaches the writing actions. */}
            <PromptInputSubmit
              tabIndex={0}
              aria-label="Ask"
              status={state === 'running' ? 'submitted' : 'ready'}
              disabled={state === 'running' || instruction.trim() === ''}
            />
          </PromptInput>
          {state === 'running' && (
            <p data-testid="ask-ai-working" className="cb-ask-ai-working cb-ai-shimmer">
              {askAiWorking(skillRun)}
            </p>
          )}
          {state === 'asking' && (
            <div className="mt-2 text-sm text-n-600">
              <button
                type="button"
                tabIndex={0}
                aria-expanded={showActions}
                className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 hover:bg-n-50"
                onClick={() => setShowActions((value) => !value)}
              >
                Writing actions
              </button>
              {showActions && (
                <Suggestions aria-label="Writing actions" className="cb-ask-ai-presets mt-1">
                  {PRESETS.map((item) => (
                    <Suggestion
                      key={item.label}
                      suggestion={item.instruction}
                      tabIndex={0}
                      data-testid="selection-preset"
                      title={item.instruction}
                      icon={null}
                      onClick={(instruction) => {
                        setInstruction(instruction);
                        ask(instruction);
                      }}
                    >
                      <Icon name={item.icon} size={14} />
                      {item.label}
                    </Suggestion>
                  ))}
                </Suggestions>
              )}
            </div>
          )}
          {state === 'asking' && skills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {/* M17.17 — Notion's move: a skill runs against selected prose,
                  not only against a chat turn. Same records, same bodies. */}
              {skills.slice(0, 6).map((skill) => (
                <button
                  key={skill.path}
                  type="button"
                  tabIndex={0}
                  data-testid="ask-ai-skill"
                  onClick={() => runSkill(skill)}
                  title={`${skill.description}${argumentHint(skill) === '' ? '' : ` — ${argumentHint(skill)}`}`}
                  className="rounded-md border border-n-200 bg-transparent px-1.5 py-0.5 text-2xs text-n-600 hover:border-n-300 hover:bg-n-25"
                >
                  /{skill.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {state === 'deciding' && (
        <Confirmation
          state="pending"
          variant="outline"
          data-testid="ask-ai-decision"
          className="cb-ask-ai-decision"
          // Said out loud when nothing changed: an empty decision list reads
          // as a failure, and "it decided nothing needed changing" is a real
          // answer.
          title={decision.title}
          summary={decision.summary}
        >
          {!isUnchanged(rewrite) && (
            <div
              data-testid="ask-ai-hunks"
              className="max-h-[240px] overflow-y-auto text-sm leading-[20px]"
            >
              {rewrite.parts.map((part, i) =>
                typeof part === 'string' ? (
                  <span key={i} className="text-n-700">
                    {part}
                  </span>
                ) : (
                  <button
                    key={i}
                    type="button"
                    tabIndex={0}
                    data-testid="ask-ai-hunk"
                    aria-pressed={accepted.has(part.id)}
                    aria-label={describeHunk(part)}
                    onClick={() => toggle(part.id)}
                    // Both sides always visible: the decision is between two
                    // readings of the sentence, and hiding one makes it a
                    // decision about a word.
                    className="mx-0.5 rounded-xs border-0 bg-transparent p-0 align-baseline"
                  >
                    {part.before !== '' && (
                      <span
                        className={
                          accepted.has(part.id)
                            ? 'text-n-400 line-through decoration-danger-500'
                            : 'rounded-xs bg-n-100 text-n-700'
                        }
                      >
                        {part.before}
                      </span>
                    )}
                    {part.after !== '' && (
                      <span
                        className={
                          accepted.has(part.id)
                            ? 'rounded-xs bg-success-50 text-success-700'
                            : 'text-n-400 line-through decoration-n-400'
                        }
                      >
                        {part.after}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5">
            <Button tabIndex={0} size="sm" variant="secondary" onClick={() => setState('asking')}>
              Retry
            </Button>
            <Button
              tabIndex={0}
              size="sm"
              variant="primary"
              onClick={() => {
                onReplace(applyHunks(rewrite, accepted));
                onClose();
              }}
            >
              {decision.apply}
            </Button>
          </div>
        </Confirmation>
      )}
    </div>
  );
}
