// Canonical reaction-emoji data shared by the web and mobile clients.
//
// Reactions are server-validated: the set here MUST stay in sync with the
// server allowlist in `surface/server/src/events.ts` (REACTION_EMOJI). The
// clients import from here so there is one client-side source of truth for the
// picker, the quick-reaction bar, and search — instead of each surface keeping
// its own hand-maintained copy.

/** The full reaction allowlist, in the server's canonical order.
 * Keep in sync with `server/src/events.ts` REACTION_EMOJI. */
export const REACTION_EMOJI = [
  '👍',
  '👎',
  '✅',
  '❌',
  '👀',
  '🎉',
  '❤️',
  '😂',
  '😄',
  '😅',
  '😊',
  '😍',
  '🤔',
  '🤯',
  '😱',
  '😢',
  '😭',
  '😡',
  '🙏',
  '👏',
  '🙌',
  '💪',
  '🤝',
  '👋',
  '🫡',
  '🤷',
  '🤦',
  '💀',
  '🔥',
  '✨',
  '⭐',
  '💯',
  '🚀',
  '🐛',
  '🔧',
  '🛠️',
  '⚙️',
  '💡',
  '📌',
  '📎',
  '📝',
  '✏️',
  '🔍',
  '⏳',
  '⏰',
  '📅',
  '☕',
  '🍕',
  '🎯',
  '🏁',
  '🚧',
  '⚠️',
  '🚨',
  '❓',
  '❗',
  '➕',
  '💬',
  '🧵',
  '🤖',
  '🧠',
  '💸',
  '📈',
  '📉',
  '🎂',
] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/** The short quick-reaction bar shown at the top of a message action menu
 * (iMessage / Discord style). All members are in {@link REACTION_EMOJI}. */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

/** Grouped presentation of the allowlist for the full picker. Every emoji in
 * {@link REACTION_EMOJI} appears in exactly one group (guarded by a test). */
export const REACTION_GROUPS: ReadonlyArray<{ name: string; emojis: readonly string[] }> = [
  {
    name: 'Smileys & people',
    emojis: [
      '👍',
      '👎',
      '👀',
      '❤️',
      '😂',
      '😄',
      '😅',
      '😊',
      '😍',
      '🤔',
      '🤯',
      '😱',
      '😢',
      '😭',
      '😡',
      '🙏',
      '👏',
      '🙌',
      '💪',
      '🤝',
      '👋',
      '🫡',
      '🤷',
      '🤦',
      '💀',
    ],
  },
  {
    name: 'Status & symbols',
    emojis: ['✅', '❌', '🎉', '🔥', '✨', '⭐', '💯', '🎯', '🏁', '🚧', '⚠️', '🚨', '❓', '❗', '➕', '💬', '🧵'],
  },
  {
    name: 'Objects & work',
    emojis: [
      '🚀',
      '🐛',
      '🔧',
      '🛠️',
      '⚙️',
      '💡',
      '📌',
      '📎',
      '📝',
      '✏️',
      '🔍',
      '⏳',
      '⏰',
      '📅',
      '☕',
      '🍕',
      '🤖',
      '🧠',
      '💸',
      '📈',
      '📉',
      '🎂',
    ],
  },
];

/** Search keywords per emoji. Used to filter the picker by typed text. */
export const REACTION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  '👍': ['thumbs up', 'up', 'yes', 'approve', 'like', 'ok', 'plus one', '+1', 'good'],
  '👎': ['thumbs down', 'down', 'no', 'disapprove', 'dislike', 'bad'],
  '✅': ['check', 'done', 'yes', 'complete', 'ok', 'green', 'pass', 'tick'],
  '❌': ['cross', 'no', 'wrong', 'fail', 'error', 'red', 'x', 'reject'],
  '👀': ['eyes', 'looking', 'watching', 'see', 'review', 'attention'],
  '🎉': ['party', 'tada', 'celebrate', 'congrats', 'yay', 'hooray', 'ship'],
  '❤️': ['heart', 'love', 'red heart'],
  '😂': ['joy', 'laugh', 'lol', 'funny', 'tears', 'haha'],
  '😄': ['smile', 'happy', 'grin', 'glad'],
  '😅': ['sweat smile', 'nervous', 'phew', 'relief'],
  '😊': ['blush', 'smile', 'happy', 'pleased'],
  '😍': ['heart eyes', 'love', 'adore', 'crush'],
  '🤔': ['thinking', 'hmm', 'consider', 'ponder', 'question'],
  '🤯': ['mind blown', 'exploding head', 'shocked', 'wow', 'whoa'],
  '😱': ['scream', 'shocked', 'fear', 'omg', 'scared'],
  '😢': ['cry', 'sad', 'tear'],
  '😭': ['sob', 'crying', 'sad', 'bawl', 'loud cry'],
  '😡': ['angry', 'mad', 'rage', 'furious'],
  '🙏': ['pray', 'thanks', 'please', 'hope', 'grateful', 'high five'],
  '👏': ['clap', 'applause', 'bravo', 'nice'],
  '🙌': ['raised hands', 'praise', 'hooray', 'celebrate'],
  '💪': ['muscle', 'strong', 'flex', 'power'],
  '🤝': ['handshake', 'deal', 'agree', 'partner'],
  '👋': ['wave', 'hi', 'hello', 'bye', 'greeting'],
  '🫡': ['salute', 'yes sir', 'ack', 'on it', 'respect'],
  '🤷': ['shrug', 'dunno', 'whatever', 'idk'],
  '🤦': ['facepalm', 'ugh', 'oops', 'disbelief'],
  '💀': ['skull', 'dead', 'dying', 'lol', 'lmao'],
  '🔥': ['fire', 'lit', 'hot', 'great', 'flame'],
  '✨': ['sparkles', 'shiny', 'clean', 'magic', 'new'],
  '⭐': ['star', 'favorite', 'rating'],
  '💯': ['hundred', '100', 'perfect', 'full', 'agree'],
  '🚀': ['rocket', 'ship', 'launch', 'fast', 'deploy'],
  '🐛': ['bug', 'defect', 'issue', 'error'],
  '🔧': ['wrench', 'fix', 'tool', 'repair', 'config'],
  '🛠️': ['tools', 'build', 'fix', 'wip', 'work'],
  '⚙️': ['gear', 'settings', 'config', 'cog', 'engine'],
  '💡': ['idea', 'bulb', 'insight', 'suggestion', 'light'],
  '📌': ['pin', 'pinned', 'important', 'sticky'],
  '📎': ['paperclip', 'attach', 'clip', 'link'],
  '📝': ['memo', 'note', 'write', 'edit', 'doc'],
  '✏️': ['pencil', 'edit', 'write', 'draft'],
  '🔍': ['search', 'magnify', 'find', 'look', 'zoom'],
  '⏳': ['hourglass', 'waiting', 'loading', 'time', 'pending'],
  '⏰': ['alarm', 'clock', 'time', 'reminder', 'deadline'],
  '📅': ['calendar', 'date', 'schedule', 'day'],
  '☕': ['coffee', 'break', 'tea', 'cafe'],
  '🍕': ['pizza', 'food', 'lunch', 'slice'],
  '🎯': ['target', 'goal', 'aim', 'bullseye', 'focus'],
  '🏁': ['finish', 'checkered flag', 'done', 'race', 'goal'],
  '🚧': ['construction', 'wip', 'blocked', 'barrier', 'work in progress'],
  '⚠️': ['warning', 'caution', 'careful', 'alert'],
  '🚨': ['siren', 'alert', 'urgent', 'emergency', 'alarm'],
  '❓': ['question', 'help', 'ask', 'what', 'unsure'],
  '❗': ['exclamation', 'important', 'alert', 'note'],
  '➕': ['plus', 'add', 'more', 'new'],
  '💬': ['speech', 'comment', 'chat', 'discuss', 'talk'],
  '🧵': ['thread', 'reply', 'discussion'],
  '🤖': ['robot', 'bot', 'agent', 'ai', 'automation'],
  '🧠': ['brain', 'smart', 'think', 'mind', 'idea'],
  '💸': ['money', 'cost', 'spend', 'cash', 'expensive'],
  '📈': ['chart up', 'growth', 'increase', 'trend up', 'gains'],
  '📉': ['chart down', 'decline', 'decrease', 'trend down', 'loss'],
  '🎂': ['cake', 'birthday', 'celebrate', 'anniversary'],
};

/** Filter the allowlist by a free-text query, matching against keywords.
 * Empty/whitespace query returns the full list unchanged. */
export function searchReactions(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...REACTION_EMOJI];
  return REACTION_EMOJI.filter((emoji) => {
    if (emoji === query.trim()) return true;
    const keywords = REACTION_KEYWORDS[emoji];
    if (!keywords) return false;
    return keywords.some((kw) => kw.includes(q));
  });
}
