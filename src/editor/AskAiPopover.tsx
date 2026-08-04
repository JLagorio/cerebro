import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { applyHunks, describeHunk, isUnchanged, rewriteHunks } from '@/engine/hunks';
import { argumentHint, listSkills, skillPrompt, type SkillRef } from '@/engine/skills';
import { readNote } from '@/lib/ipc';
import { onAgentEvent, runAgent, startMcp } from '@/agent/agentIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

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
 * ## The tool policy
 *
 * A rewrite is a pure text transformation, so the run is granted NO tools at
 * all — `allowedTools: []`, which Rust honours as "narrow to nothing" (M17.8).
 * It cannot read the vault, cannot write to it, and cannot call open_note to
 * navigate you somewhere mid-edit. What it gets is the passage, in the prompt.
 */
export function AskAiPopover({
  selection,
  onReplace,
  onClose,
}: {
  /** The exact text the user selected. */
  selection: string;
  /** Apply the decided text. Called once, with the final passage. */
  onReplace: (text: string) => void;
  onClose: () => void;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const toast = useUiStore((s) => s.toast);
  const [instruction, setInstruction] = useState('');
  const [state, setState] = useState<'asking' | 'running' | 'deciding'>('asking');
  const [result, setResult] = useState('');
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  const skills = useMemo(() => listSkills(entries), [entries]);
  const rewrite = useMemo(() => rewriteHunks(selection, result), [selection, result]);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      cancelled.current = true;
    };
  }, []);

  const run = (message: string) => {
    if (vaultPath === null || message.trim() === '') return;
    setState('running');
    setResult('');
    void (async () => {
      try {
        const mcp = await startMcp(vaultPath);
        const runId = await runAgent(vaultPath, {
          message,
          systemPrompt:
            "You rewrite a passage of the user's document and return ONLY the rewritten passage. " +
            'No preamble, no explanation, no code fence, no quotation marks around it. ' +
            'Preserve the markdown formatting of the original unless the instruction asks otherwise. ' +
            'If the instruction cannot be applied, return the passage unchanged.',
          sessionId: null,
          model: null,
          shell: false,
          connectors: false,
          attended: true,
          // No tools at all. A rewrite is a text transformation; giving it the
          // vault would let it wander, and open_note would navigate the user
          // away from the paragraph they are editing.
          allowedTools: [],
          mcp,
        });
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

  const ask = () =>
    run(
      [
        `Rewrite this passage from the user's document. Instruction: ${instruction.trim()}`,
        '',
        'Passage:',
        selection,
      ].join('\n'),
    );

  const runSkill = (skill: SkillRef) => {
    if (vaultPath === null) return;
    setState('running');
    void (async () => {
      try {
        const raw = await readNote(vaultPath, skill.path);
        // M17.17: the same record, the same body, a second entry point. The
        // skill is told the passage IS the input, so a skill written for the
        // chat works here without being rewritten for it.
        run(`${skillPrompt(skill, raw, selection)}\n\nApply it to this passage:\n${selection}`);
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
      className="w-[420px] max-w-full rounded-lg border border-n-200 bg-n-0 p-2.5 shadow-[var(--shadow-lg)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {state !== 'deciding' && (
        <>
          <div className="flex items-center gap-1.5">
            <Icon name="sparkles" size={13} color="var(--synapse-500)" />
            <input
              ref={inputRef}
              value={instruction}
              disabled={state === 'running'}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  ask();
                }
              }}
              aria-label="What should the assistant do with this passage?"
              placeholder={state === 'running' ? 'Working…' : 'Make it shorter, fix the tone…'}
              className="min-w-0 flex-1 rounded-md border border-n-200 bg-n-0 px-2 py-1.5 text-sm outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
            />
          </div>
          {state === 'asking' && skills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {/* M17.17 — Notion's move: a skill runs against selected prose,
                  not only against a chat turn. Same records, same bodies. */}
              {skills.slice(0, 6).map((skill) => (
                <button
                  key={skill.path}
                  type="button"
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
        <>
          {isUnchanged(rewrite) ? (
            // Said out loud. An empty decision list reads as a failure, and
            // "it decided nothing needed changing" is a real answer.
            <p className="m-0 px-1 py-2 text-sm text-n-500">
              The assistant left the passage as it was.
            </p>
          ) : (
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
                    data-testid="ask-ai-hunk"
                    aria-pressed={accepted.has(part.id)}
                    aria-label={describeHunk(part)}
                    onClick={() => toggle(part.id)}
                    // Both sides always visible: the decision is between two
                    // readings of the sentence, and hiding one makes it a
                    // decision about a word.
                    className="mx-0.5 rounded border-0 bg-transparent p-0 align-baseline"
                  >
                    {part.before !== '' && (
                      <span
                        className={
                          accepted.has(part.id)
                            ? 'text-n-400 line-through decoration-danger-400'
                            : 'rounded bg-n-100 text-n-700'
                        }
                      >
                        {part.before}
                      </span>
                    )}
                    {part.after !== '' && (
                      <span
                        className={
                          accepted.has(part.id)
                            ? 'rounded bg-ok-50 text-ok-700'
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
          <div className="mt-2 flex items-center gap-1.5">
            <span className="flex-1 text-2xs text-n-400">
              {isUnchanged(rewrite)
                ? ''
                : `${accepted.size} of ${rewrite.hunks.length} change${
                    rewrite.hunks.length === 1 ? '' : 's'
                  } · click one to toggle it`}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setState('asking')}>
              Retry
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onReplace(applyHunks(rewrite, accepted));
                onClose();
              }}
            >
              {accepted.size === 0 ? 'Keep mine' : 'Apply'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
