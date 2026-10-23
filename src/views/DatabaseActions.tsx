import { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';

/** Entity actions stay outside presentation settings: their scope is the
 * database/list itself, not the currently selected view. */
export function DatabaseActions({
  kind,
  onRename,
  onStyle,
  onDelete,
}: {
  kind: 'database' | 'list';
  onRename?: () => void;
  onStyle?: () => void;
  onDelete?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const select = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`${kind === 'database' ? 'Database' : 'List'} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-n-600 hover:bg-n-50"
      >
        <Icon name="ellipsis" size={16} />
      </button>
      {open && (
        <Popover
          anchorRef={anchor}
          role="menu"
          ariaLabel={`${kind} actions`}
          onClose={() => setOpen(false)}
        >
          <MenuSurface width={224}>
            <MenuLabel>{kind === 'database' ? 'Database' : 'List'}</MenuLabel>
            {onRename && (
              <MenuItem
                icon="pencil"
                label={kind === 'database' ? 'Rename database' : 'List settings'}
                onSelect={() => select(onRename)}
              />
            )}
            {onStyle && (
              <MenuItem
                icon="palette"
                label="Change icon & color"
                onSelect={() => select(onStyle)}
              />
            )}
            {onDelete && (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon="trash-2"
                  label={`Delete ${kind}`}
                  onSelect={() => select(onDelete)}
                />
              </>
            )}
          </MenuSurface>
        </Popover>
      )}
    </>
  );
}
