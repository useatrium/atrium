import type { SessionItem, ToolCallItem } from './reducer.js';

export function toolDefaultOpen(item: ToolCallItem): boolean {
  return item.result === undefined;
}

export type TranscriptRow<TChange> =
  | { kind: 'item'; item: SessionItem; index: number }
  | { kind: 'change'; change: TChange; index: number }
  | { kind: 'hidden'; count: number; key: string; startIndex: number; endIndex: number };

export function fullTranscriptRows<TChange>(
  items: readonly SessionItem[],
  changesAt: (index: number) => readonly TChange[],
): TranscriptRow<TChange>[] {
  const rows: TranscriptRow<TChange>[] = [];
  items.forEach((item, index) => {
    for (const change of changesAt(index)) rows.push({ kind: 'change', change, index });
    rows.push({ kind: 'item', item, index });
  });
  for (const change of changesAt(items.length)) {
    rows.push({ kind: 'change', change, index: items.length });
  }
  return rows;
}

export function focusTranscriptRows<TChange>(
  items: readonly SessionItem[],
  changesAt: (index: number) => readonly TChange[],
): TranscriptRow<TChange>[] {
  const rows: TranscriptRow<TChange>[] = [];
  let hiddenCount = 0;
  let hiddenKey = '';
  let hiddenStartIndex = 0;
  let hiddenEndIndex = 0;

  const flushHidden = () => {
    if (hiddenCount > 0) {
      rows.push({
        kind: 'hidden',
        count: hiddenCount,
        key: hiddenKey,
        startIndex: hiddenStartIndex,
        endIndex: hiddenEndIndex,
      });
    }
    hiddenCount = 0;
    hiddenKey = '';
  };
  const hide = (key: string, index: number) => {
    if (hiddenCount === 0) hiddenStartIndex = index;
    hiddenCount += 1;
    if (!hiddenKey) hiddenKey = key;
    hiddenEndIndex = index;
  };

  items.forEach((item, index) => {
    for (const _change of changesAt(index)) hide(`change-${index}`, index);
    if (item.type === 'reasoning' || item.type === 'tool_call') {
      hide(item.id, index);
      return;
    }
    flushHidden();
    rows.push({ kind: 'item', item, index });
  });
  for (const _change of changesAt(items.length)) {
    hide(`change-${items.length}`, items.length);
  }
  flushHidden();
  return rows;
}
