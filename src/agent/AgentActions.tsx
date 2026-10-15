import { useEffect } from 'react';
import { onUiAction } from '@/agent/agentIpc';
import { navigateTarget } from '@/engine/destinations';
import { useOpenPath } from '@/app/useOpenPath';
import { announceExternalWrites } from '@/editor/openPages';
import { useCommentsStore } from '@/stores/commentsStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { getSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * Bridges the agent's UI tools into the app (M6). Mounted once, renders
 * nothing.
 *
 * This is the half of "interact with the app" that is not about files: the
 * agent can move the user to what it is talking about, and it can put a
 * proposal in front of them. Note what it CANNOT do here — a proposal is
 * stored for review, never applied, so the agent's opinion about how to file
 * a capture never becomes a silent write.
 *
 * It also carries what the agent's write tools announce (M53.6), and what its
 * comment tools announce (M70.3). The watcher drops the echo of every write
 * the app makes, the agent's MCP writes included, so this is how the vault, a
 * page with the written file open, and a page whose comments an agent
 * changed hear about them.
 */
export function AgentActions() {
  const navigate = useNavStore((s) => s.navigate);
  const rescan = useVaultStore((s) => s.rescan);
  const addProposal = useUiStore((s) => s.addProposal);
  const selectInboxPath = useUiStore((s) => s.setInboxSelectedPath);
  // Every move this bridge makes is the agent's, so none of it lands in the
  // person's open log (M59.3). A new action that navigates passes byAgent too.
  const openPath = useOpenPath('navigate', { byAgent: true });

  useEffect(() => {
    return onUiAction((action) => {
      switch (action.action) {
        case 'open_note':
          openPath(action.path);
          break;
        case 'navigate': {
          // Rust already refused a word the served enum lacks; what is left
          // to refuse is a database this vault does not hold. A refusal
          // toasts and stays put — nothing goes Home by default (M59.1).
          const { entries } = useVaultStore.getState();
          const target = navigateTarget(action, entries, getSchema(entries));
          if ('selection' in target) navigate(target.selection, { byAgent: true });
          else useUiStore.getState().toast(target.refused);
          break;
        }
        case 'vault_changed':
          // The pages showing those files hold their saves until the rescan
          // lands, then merge the write in place (NoteBodyEditor, M55.6).
          void announceExternalWrites(action.paths ?? [], rescan);
          break;
        case 'comments_changed': {
          // Only the page's sidecar changed: reload its threads if it is
          // showing them, as the watcher's comments-changed does, and rescan
          // nothing, since no file the vault lists moved.
          const comments = useCommentsStore.getState();
          if (action.path in comments.slots) void comments.load(action.path);
          break;
        }
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
          navigate({ kind: 'inbox' }, { byAgent: true });
          break;
      }
    });
  }, [addProposal, navigate, openPath, rescan, selectInboxPath]);

  return null;
}
