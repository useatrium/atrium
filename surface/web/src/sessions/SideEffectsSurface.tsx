import { useMemo } from 'react';
import type { SideEffect, SideEffectCategory, SideEffectRisk } from '@atrium/centaur-client';
import { XIcon } from '../components/icons';

const CATEGORY_ORDER: SideEffectCategory[] = ['network', 'package', 'git', 'filesystem', 'process', 'shell'];
const RISK_BADGE: Record<SideEffectRisk, string> = {
  danger: 'bg-danger/15 text-danger-text',
  caution: 'bg-warning/15 text-warning-text',
  normal: 'bg-surface-overlay/80 text-fg-tertiary',
};

function labelFor(category: SideEffectCategory): string {
  return category[0]!.toUpperCase() + category.slice(1);
}

export function SideEffectsSurface({
  effects,
  onClose,
}: {
  effects: SideEffect[];
  onClose: () => void;
}) {
  const groups = useMemo(() => {
    const byCategory = new Map<SideEffectCategory, SideEffect[]>();
    for (const effect of effects) {
      const list = byCategory.get(effect.category);
      if (list) list.push(effect);
      else byCategory.set(effect.category, [effect]);
    }
    return CATEGORY_ORDER.map((category) => [category, byCategory.get(category) ?? []] as const).filter(
      ([, list]) => list.length > 0,
    );
  }, [effects]);

  return (
    <div
      data-testid="sideeffects-surface"
      role="dialog"
      aria-label="Side-effects"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="text-xs font-semibold text-fg">
          Side-effects <span className="tabular-nums text-fg-muted">· {effects.length}</span>
        </h3>
        <button
          onClick={onClose}
          aria-label="Close side-effects"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map(([category, list]) => (
          <section key={category} className="border-b border-edge last:border-b-0">
            <div className="flex items-center gap-2 bg-surface-raised/40 px-3 py-1.5">
              <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
                {labelFor(category)}
              </span>
              <span className="text-3xs tabular-nums text-fg-tertiary">· {list.length}</span>
            </div>
            {list.map((effect) => (
              <div key={effect.id} className="flex items-center gap-2 px-3 py-1.5">
                <span
                  className={`shrink-0 rounded px-1.5 py-px text-3xs font-semibold uppercase tracking-wide ${RISK_BADGE[effect.risk]}`}
                >
                  {effect.risk}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-body" title={effect.command}>
                  {effect.command}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
