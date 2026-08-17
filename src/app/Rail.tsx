import { useMemo } from 'react';
import { Icon } from '@/components/ui/Icon';
import { inboxCounts } from '@/engine/inbox';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The surfaces Home is the front door to (M15).
 *
 * A Collection, a List and a Type screen are the item world, and HomePage is
 * where you enter it — so the rail marks Home on all four. Spelled out rather
 * than derived by negating every other slot, which is how `changes` and
 * `settings` had to be remembered in a boolean expression to keep Home dark.
 */
const HOME_KINDS = new Set(['home', 'collection', 'list', 'type']);

function RailButton({
  icon,
  label,
  active = false,
  toggle = false,
  count,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  /**
   * This entry opens and closes a panel rather than going somewhere. Toggles
   * announce `aria-pressed`; destinations announce `aria-current="page"`.
   * Before this, a screen reader heard seven identical "…, button" and nothing
   * said which surface was current or whether the assistant was already open.
   */
  toggle?: boolean;
  /** Queue size shown as a corner badge; omitted or 0 renders nothing. */
  count?: number;
  onClick?: () => void;
}) {
  const tone = active
    ? 'bg-cortex-50 font-semibold text-cortex-600'
    : 'text-n-500 hover:bg-n-50 hover:text-n-700';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count !== undefined && count > 0 ? `${label} (${count})` : label}
      aria-current={!toggle && active ? 'page' : undefined}
      aria-pressed={toggle ? active : undefined}
      className={`relative flex w-16 flex-col items-center gap-[3px] rounded-lg border-0 bg-transparent pb-[5px] pt-1.5 text-2xs font-medium ${tone}`}
    >
      {/* A 1.13:1 tint was the entire active affordance. The bar is the part
          that survives a glance, a low-contrast display, and colour blindness. */}
      {active && (
        <span
          aria-hidden
          className="absolute -left-1.5 top-1.5 h-[calc(100%-12px)] w-[3px] rounded-full bg-cortex-500"
        />
      )}
      <Icon name={icon} size={18} />
      {count !== undefined && count > 0 && (
        <span
          data-testid="rail-badge"
          className="absolute right-1.5 top-0.5 min-w-[15px] rounded-full bg-cortex-500 px-1 text-center text-2xs font-semibold leading-[15px] text-n-0 tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
      {/* The rail is sized to its LONGEST label ("Workspace", 59px at 11px)
          rather than to its icons. Before this it was 56px wide and both
          nine-character labels overflowed their button with `overflow:
          visible`, bleeding across the rail's border into the panel beside it.
          Truncation is the backstop for whatever longer label arrives next. */}
      <span className="w-full truncate leading-tight">{label}</span>
    </button>
  );
}

export function Rail() {
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const entries = useVaultStore((s) => s.entries);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const inboxPeriod = useUiStore((s) => s.inboxPeriod);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  // Task 11: Docs owns the document surfaces; Home keeps the item world.
  // A .mmd diagram page is a document surface too (M29.21).
  const docsActive =
    selection.kind === 'docs' || selection.kind === 'doc' || selection.kind === 'diagram';
  const settingsActive = selection.kind === 'settings';
  const libraryActive = selection.kind === 'library';
  const workspaceActive = selection.kind === 'workspace';
  const inboxActive = selection.kind === 'inbox';
  const knowledgeActive = selection.kind === 'knowledge';
  // M9.4: the two git surfaces share a rail slot's worth of "history".
  const historyActive = selection.kind === 'changes' || selection.kind === 'pulse';
  const homeActive = HOME_KINDS.has(selection.kind);
  // M15: the badge counts what the page will SHOW. It used to be the unfiltered
  // total while the page opened on a persisted period, so a rail reading
  // "Inbox 9" could land you on "Nothing captured in this period".
  const queued = useMemo(
    () => (inboxEnabled ? inboxCounts(entries)[inboxPeriod] : 0),
    [entries, inboxEnabled, inboxPeriod],
  );

  return (
    <nav
      aria-label="Primary"
      data-testid="rail"
      // --n-200 like every other structural divider in the shell; at --n-100
      // the rail read as floating inside the sidebar rather than as its peer.
      className="flex w-18 flex-none flex-col items-center gap-1 border-r border-n-200 bg-n-0 py-3"
    >
      <div className="mb-3 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-cortex-500 text-lg font-bold tracking-[-0.02em] text-n-0">
        c.
      </div>
      {/* M15: an explicit list, not a derivation by elimination. Home owns the
          ITEM world — Collections, Lists and Type screens are the surfaces its
          page is the front door to — and says so here. Computed by negation it
          also lit up for any kind nobody remembered to add to the list. */}
      <RailButton
        icon="house"
        label="Home"
        active={homeActive}
        onClick={() => navigate({ kind: 'home' })}
      />
      {inboxEnabled && (
        <RailButton
          icon="inbox"
          label="Inbox"
          active={inboxActive}
          count={queued}
          onClick={() => navigate({ kind: 'inbox' })}
        />
      )}
      <RailButton
        icon="library"
        label="Docs"
        active={docsActive}
        onClick={() => navigate({ kind: 'docs' })}
      />
      {/* M30 — mounted repositories. Its own room rather than a section of
          Docs: Docs means untyped vault notes (`isDocEntry`), and a surface
          that renders .ts files cannot mean that. */}
      <RailButton
        icon="folder-tree"
        label="Workspace"
        active={workspaceActive}
        onClick={() => navigate({ kind: 'workspace' })}
      />
      {/* M5: the agent's corpus is a peer of Home and Docs, not a section
          inside them — it has a different author and different rules.
          M33a.2 folded the Status hub in here, so this one button is now both
          what the base holds and what it knows about itself — they were always
          one subject.
          Still no badge, and now for three reasons rather than one. A review
          count would be the chrome nagging you to drain a queue (M8.1); the
          same number lives on the "Needs review" row in the Knowledge sidebar,
          where it describes a destination instead. A count of contradictions
          would be worse (M27.8) — the chrome telling you your understanding is
          broken before you have asked it anything. And since M33b.3 there is a
          third tempting number in there, what your agents have queued waiting
          on you (spec D7) — which is the one this rule was written for. It
          says itself on the agent's own row, in words, and gets no colour.
          A destination may say how big it is; nothing counts up at you from
          the chrome. */}
      <RailButton
        icon="brain"
        label="Knowledge"
        active={knowledgeActive}
        onClick={() => navigate({ kind: 'knowledge' })}
      />
      {/* M9.4 — the vault's history. No badge: a count of commits is chrome
          (the same rule that kept a review count off Knowledge). The topbar
          SyncBadge speaks instead, and only when something needs doing. */}
      <RailButton
        icon="activity"
        label="History"
        active={historyActive}
        onClick={() => navigate({ kind: 'pulse' })}
      />
      <div className="flex-1" />
      {/* The assistant is a companion to whatever surface you are on, so it
          toggles rather than navigating. */}
      <RailButton
        icon="sparkles"
        label="Assistant"
        toggle
        active={aiPanelOpen}
        onClick={() => setAiPanelOpen(!aiPanelOpen)}
      />
      {/* Skills, agents and templates. Below the fold with Settings rather
          than beside Home, because it is where you go to CHANGE how the
          assistant works rather than somewhere you work.

          `blocks`, not `library` — Docs already owns that glyph, and two rail
          buttons drawn identically is the rail failing at the one job it has
          (M18). */}
      <RailButton
        icon="blocks"
        label="Library"
        active={libraryActive}
        onClick={() => navigate({ kind: 'library' })}
      />
      <RailButton
        icon="settings"
        label="Settings"
        active={settingsActive}
        onClick={() => navigate({ kind: 'settings' })}
      />
    </nav>
  );
}
