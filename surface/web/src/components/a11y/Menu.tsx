import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef } from 'react';

/**
 * Themed dropdown-menu primitives built on Radix. Provides arrow-key roving,
 * typeahead, Escape-to-close, click-away, and focus return to the trigger for
 * free — use this instead of hand-rolled `role="menu"` popovers.
 *
 * Usage:
 *   <Menu>
 *     <MenuTrigger asChild><button aria-label="Actions">…</button></MenuTrigger>
 *     <MenuContent>
 *       <MenuItem onSelect={…}>Rename</MenuItem>
 *       <MenuSeparator />
 *       <MenuItem onSelect={…}>Delete</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  className,
  sideOffset = 4,
  align = 'start',
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={`z-[80] min-w-[10rem] rounded-md border border-edge-strong bg-surface-overlay p-1 text-fg-body shadow-lg ${className ?? ''}`}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return (
    <DropdownMenu.Item
      className={`flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-body outline-none data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[disabled]:cursor-default data-[disabled]:opacity-50 ${className ?? ''}`}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={`px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-fg-faint ${className ?? ''}`}
      {...props}
    />
  );
}

export function MenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={`my-1 h-px bg-edge ${className ?? ''}`} {...props} />;
}
