import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentPropsWithoutRef } from 'react';

/**
 * Themed tabs built on Radix. Provides the WAI-ARIA tabs pattern for free:
 * `role="tablist"`/`tab`/`tabpanel`, `aria-selected`, roving tabindex, and
 * Left/Right (or Up/Down) arrow-key navigation — use this instead of a
 * hand-rolled `role="tablist"` that only responds to Tab.
 */
export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return <RadixTabs.List className={`inline-flex items-center gap-1 ${className ?? ''}`} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={`rounded px-2.5 py-1 text-sm text-fg-muted transition-colors hover:text-fg-secondary data-[state=active]:bg-surface-raised data-[state=active]:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-edge-focus ${className ?? ''}`}
      {...props}
    />
  );
}

export const TabsContent = RadixTabs.Content;
