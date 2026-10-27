import { useEffect, useRef } from 'react';
import { useCliReadiness, refreshCliReadiness } from '@/agent/useCliReadiness';
import { cliReadinessWords } from '@/agent/cliReadinessWords';
import { Button } from '@/components/ui/Button';
import { useUiStore } from '@/stores/uiStore';

/** The Settings row a failure card's Open Settings brings into view. */
export const CLAUDE_CODE_FOCUS = 'claude-code';

/**
 * Which Claude Code Cerebro runs, and how it signs in (M56.4).
 *
 * The assistant is the person's own Claude Code, signed in with their own
 * account, and no key ever enters the app. When a run fails because that CLI
 * has no sign-in, the failure card's Open Settings lands here, and this row
 * says where the fix lives: in Terminal, with the CLI's own /login.
 */
export function ClaudeCodeRow({ active = true }: { active?: boolean }) {
  const check = useCliReadiness();
  const focus = useUiStore((s) => s.settingsFocus);
  const setFocus = useUiStore((s) => s.setSettingsFocus);
  const row = useRef<HTMLDivElement>(null);

  // A one-shot: scroll here once, then forget it, so a later visit to
  // Settings opens at the top as usual.
  useEffect(() => {
    if (!active || focus !== CLAUDE_CODE_FOCUS) return;
    row.current?.scrollIntoView({ block: 'center' });
    setFocus(null);
  }, [active, focus, setFocus]);

  const found = check.state === 'available' ? check : null;
  return (
    <div
      ref={row}
      data-testid="settings-claude-code"
      className="cb-setting-row flex items-start gap-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-n-800">Claude Code</div>
        <div className="mt-0.5 text-xs leading-[16px] text-n-500">
          Cerebro runs your own copy and uses its sign-in; no key enters the app. If a run says
          Claude Code isn't signed in, open Terminal, run claude, and type /login.
        </div>
        <div
          role="status"
          data-testid="settings-claude-code-status"
          className="mt-1 text-xs leading-[16px] text-n-700"
        >
          {cliReadinessWords(check)}
          {found?.path != null && (
            <span className="block break-all [font-family:var(--font-mono)] text-n-500">
              {found.path}
            </span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        disabled={check.state === 'checking'}
        onClick={() => {
          void refreshCliReadiness();
        }}
      >
        {check.state === 'unavailable' ? 'Retry check' : 'Check again'}
      </Button>
    </div>
  );
}
