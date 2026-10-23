import { openBesideIntent } from './openIntent';
import { revealTheme } from './shellMotion';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import { destination } from '@/engine/destinations';
import { useLauncherStore } from '@/stores/launcherStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore, type ThemeMode } from '@/stores/uiStore';
import { NAV_AREAS, type NavArea } from './shellNavigation';

const THEME_ICONS: Record<ThemeMode, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };

/** Persistent navigation stays available even when the contextual panel folds.
 * Explicit tab stops keep every rail action reachable in WebKit regardless
 * of macOS's default exclusion of native buttons from sequential focus. */
export function AppRail({
  area,
  onArea,
  expanded,
  onExpand,
  inert = false,
}: {
  area: NavArea;
  onArea(area: NavArea): void;
  expanded: boolean;
  onExpand(): void;
  inert?: boolean;
}) {
  const ui = useUiStore();
  const selection = useNavStore((state) => state.selection);
  const chat = ui.aiPanelOpen && ui.aiPanelPresentation === 'canvas';
  const assistantVisible =
    ui.aiPanelOpen && (ui.aiPanelPresentation !== 'floating' || !ui.aiPanelMinimized);
  const pageArea = !chat && selection.kind !== 'settings';
  const openLauncher = useLauncherStore((state) => state.openLauncher);
  return (
    <nav
      aria-label="Application"
      data-testid="app-rail"
      data-key-neutral
      inert={inert}
      className="m71-app-rail"
    >
      <Tooltip label="Cerebro · Home">
        <button
          type="button"
          tabIndex={0}
          aria-label="Cerebro · Home"
          className="m71-brand"
          onClick={() => onArea('home')}
        >
          c<span>.</span>
        </button>
      </Tooltip>
      <Tooltip label="Search" command="palette.open">
        <button
          type="button"
          tabIndex={0}
          aria-label="Search"
          className="m71-rail-button"
          onClick={(event) => {
            event.currentTarget.focus();
            ui.setQuickOpen(true);
          }}
        >
          <Icon name="search" size={19} />
        </button>
      </Tooltip>
      <Tooltip label="New" command="create.launcher">
        <button
          type="button"
          tabIndex={0}
          aria-label="New"
          className="m71-rail-button"
          onClick={(event) => {
            event.currentTarget.focus();
            openLauncher();
          }}
        >
          <Icon name="plus" size={20} />
        </button>
      </Tooltip>
      <div className="m71-rail-rule" />
      <div className="m71-rail-areas">
        <Tooltip label="Assistant" command="assistant.toggle">
          <button
            type="button"
            tabIndex={0}
            aria-label="Assistant"
            aria-pressed={assistantVisible}
            className="m71-rail-button m71-rail-assistant"
            data-active={assistantVisible || undefined}
            onClick={ui.openAssistantFloating}
          >
            <Icon name="sparkles" size={20} />
          </button>
        </Tooltip>
        {NAV_AREAS.map((item) => (
          <Tooltip
            key={item.id}
            label={item.label}
            command={item.destination ? `go.${destination(item.destination).id}` : undefined}
          >
            <button
              type="button"
              tabIndex={0}
              aria-label={item.label}
              aria-pressed={pageArea && area === item.id}
              data-active={(pageArea && area === item.id) || undefined}
              data-nav-area={item.id}
              className="m71-rail-button"
              onClick={() => onArea(item.id)}
            >
              <Icon name={item.icon} size={20} />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="m71-rail-footer">
        {!expanded && (
          <Tooltip label="Show sidebar">
            <button
              type="button"
              tabIndex={0}
              aria-label="Show sidebar"
              data-testid="sidebar-expand"
              // It arrives as the sidebar goes, rather than blinking in (shell.css).
              className="m71-rail-button m71-rail-arrive"
              onClick={onExpand}
            >
              <Icon name="panel-left" size={19} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={`Theme: ${ui.themeMode}`}>
          <button
            type="button"
            tabIndex={0}
            aria-label={`Theme: ${ui.themeMode}`}
            className="m71-rail-button"
            // The same stored word as ever; light and dark trading places
            // spread out from this button (app/shellMotion.ts).
            onClick={(event) => revealTheme(THEME_NEXT[ui.themeMode], event.currentTarget)}
          >
            {/* Keyed, so each mode's glyph turns into place (shell.css). */}
            <Icon
              key={ui.themeMode}
              name={THEME_ICONS[ui.themeMode]}
              size={18}
              className="m71-theme-glyph"
            />
          </button>
        </Tooltip>
        <Tooltip label="Settings" command="go.settings">
          <button
            type="button"
            tabIndex={0}
            aria-label="Settings"
            aria-current={!chat && selection.kind === 'settings' ? 'page' : undefined}
            className="m71-rail-button"
            onClick={() => {
              if (chat) ui.setAiPanelPresentation('floating');
              const nav = useNavStore.getState();
              (openBesideIntent() ? nav.openPane : nav.navigate)(destination('settings').selection);
            }}
          >
            <Icon name="settings" size={19} />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
