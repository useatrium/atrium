import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionScreenSource = readFileSync(
  resolve(__dirname, '../app/(app)/session/[id].tsx'),
  'utf8',
);

describe('session transcript action wiring', () => {
  it('wires long-press actions for every transcript entry type', () => {
    expect(sessionScreenSource).toContain("item.type === 'text'");
    expect(sessionScreenSource).toContain("item.type === 'user_message'");
    expect(sessionScreenSource).toContain("item.type === 'question'");
    expect(sessionScreenSource).toContain("item.type === 'reasoning'");
    expect(sessionScreenSource).toContain("item.type === 'tool_call'");
    expect(sessionScreenSource).toContain('onLongPress={openActionsWithHaptic}');
    expect(sessionScreenSource).toContain('onLongPress={hasActions ? openActionsWithHaptic : undefined}');
    expect(sessionScreenSource).toContain('delayLongPress={250}');
  });
});
