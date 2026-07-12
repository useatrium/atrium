import type { SessionItem, ToolCallItem } from '@atrium/centaur-client';

export function toolDefaultOpen(item: ToolCallItem): boolean {
  return item.result === undefined;
}

export type TranscriptViewRow<TChange> =
  | { kind: 'item'; item: SessionItem }
  | { kind: 'change'; change: TChange }
  | { kind: 'hidden'; count: number; key: string };

export function focusTranscriptRows<TChange>(
  items: SessionItem[],
  changesAt: (index: number) => TChange[],
): TranscriptViewRow<TChange>[] {
  const rows: TranscriptViewRow<TChange>[] = [];
  let hiddenCount = 0;
  let hiddenKey = '';
  const flushHidden = () => {
    if (hiddenCount > 0) rows.push({ kind: 'hidden', count: hiddenCount, key: hiddenKey });
    hiddenCount = 0;
    hiddenKey = '';
  };
  const hide = (key: string) => {
    hiddenCount += 1;
    if (!hiddenKey) hiddenKey = key;
  };

  items.forEach((item, index) => {
    for (let changeIndex = 0; changeIndex < changesAt(index).length; changeIndex += 1) {
      hide(`change-${index}`);
    }
    if (item.type === 'reasoning' || item.type === 'tool_call') {
      hide(item.id);
      return;
    }
    flushHidden();
    rows.push({ kind: 'item', item });
  });
  for (let changeIndex = 0; changeIndex < changesAt(items.length).length; changeIndex += 1) {
    hide(`change-${items.length}`);
  }
  flushHidden();
  return rows;
}

export function fullTranscriptRows<TChange>(
  items: SessionItem[],
  changesAt: (index: number) => TChange[],
): TranscriptViewRow<TChange>[] {
  const rows: TranscriptViewRow<TChange>[] = [];
  items.forEach((item, index) => {
    for (const change of changesAt(index)) rows.push({ kind: 'change', change });
    rows.push({ kind: 'item', item });
  });
  for (const change of changesAt(items.length)) rows.push({ kind: 'change', change });
  return rows;
}
