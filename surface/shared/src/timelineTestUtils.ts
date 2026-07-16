import { expect } from 'vitest';
import type { ChannelTimeline } from './timeline';

export function expectNoDuplicateConfirmedIds(t: ChannelTimeline): void {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const row of [...t.main, ...Object.values(t.threads).flat()]) {
    if (row.status !== 'confirmed' || row.id === null) continue;
    if (seen.has(row.id)) duplicates.add(row.id);
    else seen.add(row.id);
  }
  expect([...duplicates]).toEqual([]);
}
