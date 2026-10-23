import { Icon } from '@/components/ui/Icon';

/** Presentation only. Every control still belongs to its existing settings surface. */
export const SETTINGS_SECTIONS = [
  {
    id: 'general',
    label: 'General',
    icon: 'sliders-horizontal',
    group: 'Preferences',
    description: 'Make Cerebro feel at home.',
  },
  {
    id: 'reminders',
    label: 'Reminders',
    icon: 'bell',
    group: 'Preferences',
    description: 'Choose how reminders reach you.',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: 'keyboard',
    group: 'Preferences',
    description: 'Keep your hands on the keyboard.',
  },
  {
    id: 'vault',
    label: 'Vault',
    icon: 'folder-open',
    group: 'Workspace',
    description: 'Your files, in a folder you control.',
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    icon: 'brain',
    group: 'Workspace',
    description: 'Decide how your knowledge base grows.',
  },
  {
    id: 'history',
    label: 'History',
    icon: 'history',
    group: 'Workspace',
    description: 'Keep versions and connect your repository.',
  },
  {
    id: 'trash',
    label: 'Recently deleted',
    icon: 'trash-2',
    group: 'Workspace',
    description: 'Restore files from this vault’s Trash.',
  },
  {
    id: 'assistant',
    label: 'Assistant',
    icon: 'sparkles',
    group: 'Connections',
    description: 'Your Claude Code, with boundaries you choose.',
  },
  {
    id: 'mail',
    label: 'Mail',
    icon: 'mail',
    group: 'Connections',
    description: 'Control what stays in your workspace.',
  },
  {
    id: 'clients',
    label: 'Other apps',
    icon: 'plug',
    group: 'Connections',
    description: 'Give other apps a specific way into this vault.',
  },
  {
    id: 'about',
    label: 'About',
    icon: 'info',
    group: null,
    description: 'A workspace that stays yours.',
  },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

export function SettingsNavigation({
  selected,
  onSelect,
  inline = false,
}: {
  selected: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  inline?: boolean;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className={`cb-settings-nav${inline ? ' cb-settings-nav-inline' : ''}`}
    >
      {SETTINGS_SECTIONS.map((section, index) => (
        <div key={section.id}>
          {section.group !== null && section.group !== SETTINGS_SECTIONS[index - 1]?.group && (
            <div className="cb-settings-nav-group">{section.group}</div>
          )}
          <button
            type="button"
            className="cb-nav-row"
            data-page-navigation-item
            data-settings-section={section.id}
            aria-current={selected === section.id ? 'page' : undefined}
            onClick={() => onSelect(section.id)}
          >
            <Icon name={section.icon} size={16} />
            <span>{section.label}</span>
          </button>
        </div>
      ))}
    </nav>
  );
}
