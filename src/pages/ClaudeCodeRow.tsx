import { useEffect, useRef, useState } from 'react';
import { checkAgent } from '@/agent/agentIpc';
import type { AgentStatus } from '@/agent/types';
import { useUiStore } from '@/stores/uiStore';

/** The Settings row a failure card's Open Settings brings into view. */
export const CLAUDE_CODE_FOCUS = 'claude-code';

/** What the row knows: still asking, the answer, or that asking failed. */
type Check = { state: 'checking' } | { state: 'done'; status: AgentStatus } | { state: 'failed' };

/**
 * Which Claude Code Cerebro runs, and how it signs in (M56.4).
 *
 * The assistant is the person's own Claude Code, signed in with their own
 * account, and no key ever enters the app. When a run fails because that CLI
 * has no sign-in, the failure card's Open Settings lands here, and this row
 * says where the fix lives: in Terminal, with the CLI's own /login.
 */
export function ClaudeCodeRow() {
  const [check, setCheck] = useState<Check>({ state: 'checking' });
  const focus = useUiStore((s) => s.settingsFocus);
  const setFocus = useUiStore((s) => s.setSettingsFocus);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    checkAgent()
      .then((status) => {
        if (live) setCheck({ state: 'done', status });
      })
      .catch(() => {
        if (live) setCheck({ state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, []);

  // A one-shot: scroll here once, then forget it, so a later visit to
  // Settings opens at the top as usual.
  useEffect(() => {
    if (focus !== CLAUDE_CODE_FOCUS) return;
    row.current?.scrollIntoView({ block: 'center' });
    setFocus(null);
  }, [focus, setFocus]);

  const found = check.state === 'done' ? check.status : null;
  return (
    <div ref={row} data-testid="settings-claude-code" className="flex items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-n-800">Claude Code</div>
        <div className="mt-0.5 text-xs leading-[16px] text-n-500">
          Cerebro runs your own copy and uses its sign-in; no key enters the app. If a run says
          Claude Code isn't signed in, open Terminal, run claude, and type /login.
        </div>
        <div
          data-testid="settings-claude-code-status"
          className="mt-1 text-xs leading-[16px] text-n-700"
        >
          {check.state === 'checking' && 'Checking for Claude Code…'}
          {check.state === 'failed' && "Couldn't check for Claude Code on this machine."}
          {found !== null &&
            (found.installed ? (
              <>
                Claude Code {found.version ?? '(version not reported)'}
                {found.path !== null && (
                  <span className="block break-all [font-family:var(--font-mono)] text-n-500">
                    {found.path}
                  </span>
                )}
              </>
            ) : (
              'Claude Code was not found on this machine. Install it, then reopen Cerebro.'
            ))}
        </div>
      </div>
    </div>
  );
}
