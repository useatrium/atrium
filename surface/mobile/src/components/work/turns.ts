import type { SessionItem } from '@atrium/centaur-client';

export interface Turn {
  id: string;
  index: number;
  label: string;
  itemId: string;
}

const EXCERPT_LIMIT = 40;

function steerExcerpt(text: string | undefined): string {
  const normalized = (text ?? '').trim().replace(/\s+/g, ' ');
  if (normalized.length <= EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, EXCERPT_LIMIT - 3).trimEnd()}...`;
}

function turnLabel(index: number, text: string | undefined): string {
  const excerpt = steerExcerpt(text);
  return excerpt ? `Turn ${index} - ${excerpt}` : `Turn ${index}`;
}

export function deriveTurns(items: SessionItem[]): Turn[] {
  const [first] = items;
  if (!first) return [];

  const turns: Turn[] = [];
  const pushTurn = (item: SessionItem) => {
    const index = turns.length + 1;
    const steerText = item.type === 'user_message' ? item.text : undefined;
    turns.push({
      id: item.id,
      index,
      label: turnLabel(index, steerText),
      itemId: item.id,
    });
  };

  pushTurn(first);
  for (let i = 1; i < items.length; i += 1) {
    const item = items[i];
    if (item?.type === 'user_message') pushTurn(item);
  }

  return turns;
}
