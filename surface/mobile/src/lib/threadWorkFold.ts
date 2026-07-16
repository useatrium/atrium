import { toolDisplay, type FoldedTurnRow } from '@atrium/centaur-client';
import { formatDurationUnits } from '@atrium/surface-client';
import type { WorkFoldStep } from '../components/HiddenWorkChip';

export interface ThreadWorkFoldView {
  steps: WorkFoldStep[];
  duration?: string;
}

function workFoldStep(item: FoldedTurnRow['items'][number]): WorkFoldStep {
  if (item.type === 'reasoning') {
    return { id: item.id, label: item.summary || 'Reasoning', detail: item.text, status: 'done' };
  }

  const descriptor = toolDisplay(item);
  const detail = [JSON.stringify(item.input, null, 2), item.result?.content].filter(Boolean).join('\n\n');
  return {
    id: item.id,
    label: descriptor.subtitle ? `${descriptor.title} · ${descriptor.subtitle}` : descriptor.title,
    detail,
    status: item.result === undefined ? 'running' : item.result.is_error ? 'failed' : 'done',
  };
}

/** Maps shared turn segmentation into the existing mobile fold presentation. */
export function mapFoldedTurnRow(fold: FoldedTurnRow): ThreadWorkFoldView {
  return {
    steps: fold.items.map(workFoldStep),
    ...(fold.durationMs !== undefined ? { duration: formatDurationUnits(fold.durationMs) } : {}),
  };
}
