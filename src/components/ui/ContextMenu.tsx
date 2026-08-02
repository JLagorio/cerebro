import { useEffect, useRef } from 'react';
import { Icon } from '@/components/ui/Icon';

export interface ContextMenuItem {
  icon: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

const MENU_WIDTH = 200;

/**
 * Right-click menu (M2 Task 14): fixed at the pointer, clamped to the
 * viewport. Backdrop click and Escape close it; arrows/Home/End move focus.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    buttons?.[0]?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const index = buttons.findIndex((b) => b === document.activeElement);
    const focus = (i: number) => buttons[Math.max(0, Math.min(buttons.length - 1, i))]?.focus();
    switch (e.key) {
      case 'Escape':
        e.stopPropagation();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        focus(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focus(0);
        break;
      case 'End':
        e.preventDefault();
        focus(buttons.length - 1);
        break;
    }
  };

  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - items.length * 30 - 12));

  return (
    <>
      <div
        data-testid="context-menu-backdrop"
        className="fixed inset-0 z-40"
        onClick={onClose}
        onWheel={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        onKeyDown={onKeyDown}
        style={{ left, top, width: MENU_WIDTH }}
        className="cb-menu-in fixed z-50 rounded-lg border border-[var(--n-200)] bg-[var(--n-0)] py-1 shadow-[0_8px_24px_rgba(22,26,36,0.14)]"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={[
              'flex w-full items-center gap-2 border-0 bg-transparent px-2.5 py-[5px] text-left text-[12.5px]',
              item.danger
                ? 'text-[var(--danger-600)] hover:bg-[var(--danger-50)]'
                : 'text-[var(--n-700)] hover:bg-[var(--n-50)]',
            ].join(' ')}
          >
            <Icon name={item.icon} size={13} />
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
