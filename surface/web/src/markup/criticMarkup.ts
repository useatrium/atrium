import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';

type InlineSegment = {
  kind: 'normal' | 'insertion' | 'deletion' | 'comment';
  text: string;
  comment?: string;
};

const criticMarkNames = new Set(['insertion', 'deletion', 'comment']);

export function serializeToCriticMarkup(doc: ProseMirrorNode): string {
  const blocks: string[] = [];
  doc.forEach((child) => {
    blocks.push(renderBlock(child));
  });
  return blocks.join('\n\n');
}

function escapeCriticText(value: string): string {
  return value
    .replace(/\{(?=(?:\+\+|--|~~|==|>>))/g, '\\{')
    .replace(/(\+\+|--|~~|==|>>|<<)\}/g, '$1\\}');
}

function renderInline(node: ProseMirrorNode): string {
  const segments = flattenInline(node);
  let output = '';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    const next = segments[index + 1];

    if (segment.kind === 'deletion' && next?.kind === 'insertion') {
      output += `{~~${segment.text}~>${next.text}~~}`;
      index += 1;
      continue;
    }
    if (segment.kind === 'deletion') {
      output += `{--${segment.text}--}`;
      continue;
    }
    if (segment.kind === 'insertion') {
      output += `{++${segment.text}++}`;
      continue;
    }
    if (segment.kind === 'comment') {
      output += `{==${segment.text}==}{>>${escapeCriticText(segment.comment || '')}<<}`;
      continue;
    }
    output += segment.text;
  }

  return output;
}

function flattenInline(node: ProseMirrorNode): InlineSegment[] {
  const segments: InlineSegment[] = [];
  node.forEach((child) => {
    if (child.isText) {
      appendSegment(segments, segmentForText(child.text || '', child.marks));
      return;
    }
    if (child.type.name === 'hard_break') {
      appendSegment(segments, { kind: 'normal', text: '\\\n' });
      return;
    }
    if (child.type.name === 'image') {
      appendSegment(segments, { kind: 'normal', text: renderImage(child) });
    }
  });
  return segments;
}

function appendSegment(segments: InlineSegment[], next: InlineSegment): void {
  if (!next.text) {
    return;
  }
  const previous = segments[segments.length - 1];
  if (previous && previous.kind === next.kind && previous.comment === next.comment) {
    previous.text += next.text;
    return;
  }
  segments.push(next);
}

function segmentForText(text: string, marks: readonly Mark[]): InlineSegment {
  const comment = marks.find((mark) => mark.type.name === 'comment');
  const insertion = marks.some((mark) => mark.type.name === 'insertion');
  const deletion = marks.some((mark) => mark.type.name === 'deletion');
  if (insertion && deletion) {
    return { kind: 'normal', text: '' };
  }

  const code = marks.some((mark) => mark.type.name === 'code');
  const renderedText = renderMarkdownMarks(code ? text : escapeCriticText(text), marks);

  if (comment) {
    return { kind: 'comment', text: renderedText, comment: String(comment.attrs.text || '') };
  }
  if (insertion) {
    return { kind: 'insertion', text: renderedText };
  }
  if (deletion) {
    return { kind: 'deletion', text: renderedText };
  }
  return { kind: 'normal', text: renderedText };
}

function renderMarkdownMarks(text: string, marks: readonly Mark[]): string {
  let output = text;
  const baseMarks = marks.filter((mark) => !criticMarkNames.has(mark.type.name));

  const code = baseMarks.find((mark) => mark.type.name === 'code');
  if (code) {
    return `\`${output.replace(/`/g, '\\`')}\``;
  }

  if (baseMarks.some((mark) => mark.type.name === 'strong')) {
    output = `**${output}**`;
  }
  if (baseMarks.some((mark) => mark.type.name === 'em')) {
    output = `*${output}*`;
  }

  const link = baseMarks.find((mark) => mark.type.name === 'link');
  if (link) {
    const title = link.attrs.title ? ` "${String(link.attrs.title).replace(/"/g, '\\"')}"` : '';
    output = `[${output}](${String(link.attrs.href)}${title})`;
  }

  return output;
}

function renderImage(node: ProseMirrorNode): string {
  const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
  return `![${escapeCriticText(String(node.attrs.alt || ''))}](${String(node.attrs.src)}${title})`;
}

function renderBlock(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case 'heading':
      return `${'#'.repeat(node.attrs.level)} ${renderInline(node)}`;
    case 'paragraph':
      return renderInline(node);
    case 'bullet_list':
      return renderList(node, '-');
    case 'ordered_list':
      return renderOrderedList(node);
    case 'list_item':
      return renderListItem(node, '-');
    case 'code_block':
      return renderCodeBlock(node);
    case 'blockquote':
      return renderBlockquote(node);
    case 'horizontal_rule':
      return '---';
    default:
      return renderChildBlocks(node);
  }
}

function renderList(node: ProseMirrorNode, marker: string): string {
  const items: string[] = [];
  node.forEach((child) => {
    items.push(renderListItem(child, marker));
  });
  return items.join('\n');
}

function renderOrderedList(node: ProseMirrorNode): string {
  const start = Number(node.attrs.order || 1);
  const items: string[] = [];
  node.forEach((child, _offset, index) => {
    items.push(renderListItem(child, `${start + index}.`));
  });
  return items.join('\n');
}

function renderListItem(node: ProseMirrorNode, marker: string): string {
  const blocks: string[] = [];
  node.forEach((child) => {
    blocks.push(renderBlock(child));
  });
  const rendered = blocks.join('\n\n');
  const continuation = ' '.repeat(marker.length + 1);
  return `${marker} ${indentMultiline(rendered, continuation).slice(continuation.length)}`;
}

function renderCodeBlock(node: ProseMirrorNode): string {
  const params = node.attrs.params ? String(node.attrs.params) : '';
  const fence = `\`\`\`${params}\n${node.textContent}\n\`\`\``;
  if (node.attrs.comment) {
    // Keep code byte-identical; limitation: code containing "==}" can confuse
    // a future CriticMarkup importer of this block-comment wrapper.
    return `{==${fence}==}{>>${escapeCriticText(String(node.attrs.comment))}<<}`;
  }
  return fence;
}

function renderBlockquote(node: ProseMirrorNode): string {
  const blocks: string[] = [];
  node.forEach((child) => {
    blocks.push(renderBlock(child));
  });
  return indentMultiline(blocks.join('\n\n'), '> ');
}

function renderChildBlocks(node: ProseMirrorNode): string {
  const blocks: string[] = [];
  node.forEach((child) => {
    blocks.push(renderBlock(child));
  });
  return blocks.join('\n\n');
}

function indentMultiline(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
