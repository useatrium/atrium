export type LineDiffOp = { kind: 'context' | 'remove' | 'add'; text: string };

const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function positionalLineDiff(oldLines: string[], newLines: string[]): LineDiffOp[] {
  const out: LineDiffOp[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) out.push({ kind: 'context', text: oldLine ?? '' });
    else {
      if (oldLine !== undefined) out.push({ kind: 'remove', text: oldLine });
      if (newLine !== undefined) out.push({ kind: 'add', text: newLine });
    }
  }
  return out;
}

export function lineDiffOps(oldText: string, newText: string): LineDiffOp[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) return positionalLineDiff(oldLines, newLines);

  const dp = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'context', text: oldLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'remove', text: oldLines[i] ?? '' });
      i += 1;
    } else {
      out.push({ kind: 'add', text: newLines[j] ?? '' });
      j += 1;
    }
  }
  while (i < oldLines.length) out.push({ kind: 'remove', text: oldLines[i++] ?? '' });
  while (j < newLines.length) out.push({ kind: 'add', text: newLines[j++] ?? '' });
  return out;
}
