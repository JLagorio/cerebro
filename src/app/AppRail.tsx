import { openBesideIntent } from './openIntent';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import { destination } from '@/engine/destinations';
import { useLauncherStore } from '@/stores/launcherStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore, type ThemeMode } from '@/stores/uiStore';
import { NAV_AREAS, type NavArea } from './shellNavigation';

const THEME_ICONS: Record<ThemeMode, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };

/** Persistent navigation stays available even when the contextual panel folds. */
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
          aria-label="Search"
          className="m71-rail-button"
          onClick={() => ui.setQuickOpen(true)}
        >
          <Icon name="search" size={19} />
        </button>
      </Tooltip>
      <Tooltip label="New" command="create.launcher">
        <button type="button" aria-label="New" className="m71-rail-button" onClick={openLauncher}>
          <Icon name="plus" size={20} />
        </button>
      </Tooltip>
      <div className="m71-rail-rule" />
      <div className="m71-rail-areas">
        <Tooltip label="Assistant" command="assistant.toggle">
          <button
            type="button"
            aria-label="Assistant"
            aria-pressed={chat}
            className="m71-rail-button m71-rail-assistant"
            data-active={chat || undefined}
            onClick={ui.openAssistantCanvas}
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
              aria-label="Show sidebar"
              data-testid="sidebar-expand"
              className="m71-rail-button"
              onClick={onExpand}
            >
              <Icon name="panel-left" size={19} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={`Theme: ${ui.themeMode}`}>
          <button
            type="button"
            aria-label={`Theme: ${ui.themeMode}`}
            className="m71-rail-button"
            onClick={() => ui.setThemeMode(THEME_NEXT[ui.themeMode])}
          >
            <Icon name={THEME_ICONS[ui.themeMode]} size={18} />
          </button>
        </Tooltip>
        <Tooltip label="Settings" command="go.settings">
          <button
            type="button"
            aria-label="Settings"
            aria-current={!chat && selection.kind === 'settings' ? 'page' : undefined}
            className="m71-rail-button"
            onClick={() => {
              ui.setAiPanelPresentation('panel');
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
