import { useEffect } from 'react';
import { onUiAction } from '@/agent/agentIpc';
import type { Selection } from '@/engine/types';
import { useOpenPath } from '@/app/useOpenPath';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Bridges the agent's UI tools into the app (M6). Mounted once, renders
 * nothing.
 *
 * This is the half of "interact with the app" that is not about files: the
 * agent can move the user to what it is talking about, and it can put a
 * proposal in front of them. Note what it CANNOT do here — a proposal is
 * stored for review, never applied, so the agent's opinion about how to file
 * a capture never becomes a silent write.
 */
export function AgentActions() {
  const navigate = useNavStore((s) => s.navigate);
  const rescan = useVaultStore((s) => s.rescan);
  const addProposal = useUiStore((s) => s.addProposal);
  const selectInboxPath = useUiStore((s) => s.setInboxSelectedPath);
  const openPath = useOpenPath();

  useEffect(() => {
    return onUiAction((action) => {
      switch (action.action) {
        case 'open_note':
          openPath(action.path);
          break;
        case 'navigate':
          navigate(toSelection(action.to, action.id));
          break;
        case 'vault_changed':
          void rescan().catch(() => undefined);
          break;
        case 'propose_organize':
          addProposal({
            path: action.path,
            type: action.type,
            title: action.title,
            properties: action.properties,
            reasoning: action.reasoning,
          });
          // Open the capture the proposal is ABOUT. Without this the queue
          // falls back to its own head, so the card only appeared when the
          // agent happened to propose for the first capture — a suggestion
          // silently filed behind another note is exactly the outcome
          // propose_organize exists to prevent.
          selectInboxPath(action.path);
          // The Inbox is where a proposal is actionable, so go there — but
          // only to show it. Accepting is still the user's click.
          navigate({ kind: 'inbox' });
          break;
      }
    });
  }, [addProposal, navigate, openPath, rescan, selectInboxPath]);

  return null;
}

/** Map the agent's surface name onto a Selection; unknown names go Home. */
export function toSelection(to: string, id?: string): Selection {
  switch (to) {
    case 'inbox':
      return { kind: 'inbox' };
    case 'knowledge':
      return { kind: 'knowledge' };
    case 'docs':
      return { kind: 'docs' };
    case 'list':
      return id !== undefined ? { kind: 'list', id } : { kind: 'home' };
    default:
      return { kind: 'home' };
  }
}
