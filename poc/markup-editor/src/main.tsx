import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { baseKeymap } from "prosemirror-commands";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { defaultMarkdownParser, schema as markdownSchema } from "prosemirror-markdown";
import { Mark, MarkSpec, Node as ProseMirrorNode, NodeSpec, Schema } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "./styles.css";

const sampleMarkdown = `# Release Review Memo

The agent-produced draft has a clear structure, but priority sections still need tracked editorial changes before it is sent to the team.

## Open Questions

- Should the launch checklist include the data export review?
- Does the migration note need a stronger warning?
- Are the support owners named clearly enough?

The second paragraph is intentionally worded in a way that invites a comment. It should remain readable while annotations sit beside it.

\`\`\`ts
export function summarize(items: string[]) {
  return items.map((item) => item.trim()).filter(Boolean).join(", ");
}
\`\`\`

Final paragraph with plain markdown text so serialization can prove that untouched prose survives next to CriticMarkup suggestions.`;

const insertionMarkSpec: MarkSpec = {
  inclusive: false,
  parseDOM: [{ tag: "ins[data-suggestion-insertion]" }],
  toDOM: () => ["ins", { "data-suggestion-insertion": "true", class: "suggestion-insert" }, 0] as const,
};

const deletionMarkSpec: MarkSpec = {
  inclusive: false,
  parseDOM: [{ tag: "del[data-suggestion-deletion]" }],
  toDOM: () => ["del", { "data-suggestion-deletion": "true", class: "suggestion-delete" }, 0] as const,
};

const commentMarkSpec: MarkSpec = {
  attrs: {
    id: { default: "" },
    text: { default: "" },
  },
  inclusive: false,
  parseDOM: [
    {
      tag: "span[data-comment-text]",
      getAttrs: (dom) => ({
        id: (dom as HTMLElement).getAttribute("data-comment-id") || "",
        text: (dom as HTMLElement).getAttribute("data-comment-text") || "",
      }),
    },
  ],
  toDOM: (mark: Mark) => [
    "span",
    {
      class: "comment-mark",
      "data-comment-id": mark.attrs.id,
      "data-comment-text": mark.attrs.text,
    },
    0,
  ] as const,
};

const baseCodeBlockSpec = markdownSchema.spec.nodes.get("code_block");
const codeBlockWithCommentSpec: NodeSpec = {
  ...baseCodeBlockSpec,
  attrs: {
    ...(baseCodeBlockSpec?.attrs || {}),
    params: { default: "" },
    comment: { default: "" },
  },
  toDOM: (node: ProseMirrorNode) =>
    [
    "pre",
    {
      "data-code-block-comment": node.attrs.comment || null,
      class: node.attrs.comment ? "code-block has-block-comment" : "code-block",
    },
    ["code", 0],
  ] as const,
};

const editorSchema = new Schema({
  nodes: markdownSchema.spec.nodes.update("code_block", codeBlockWithCommentSpec),
  marks: markdownSchema.spec.marks.append({
    insertion: insertionMarkSpec,
    deletion: deletionMarkSpec,
    comment: commentMarkSpec,
  }),
});

type PopoverMode = "closed" | "menu" | "suggest" | "comment";

type PopoverState = {
  mode: PopoverMode;
  top: number;
  left: number;
  codeBlock: boolean;
};

const emptyPopover: PopoverState = {
  mode: "closed",
  top: 0,
  left: 0,
  codeBlock: false,
};

function makeInitialDoc() {
  const parsed = defaultMarkdownParser.parse(sampleMarkdown);
  return editorSchema.nodeFromJSON(parsed.toJSON());
}

function isInCodeBlock(state: EditorState) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if ($from.node(depth).type.name === "code_block") {
      return true;
    }
  }
  return false;
}

function findCodeBlockAtSelection(state: EditorState) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "code_block") {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

function makeSuggestionPlugin(
  suggestingRef: React.MutableRefObject<boolean>,
  onChange: (doc: ProseMirrorNode) => void,
  onSelection: (view: EditorView) => void,
) {
  return new Plugin({
    view(editorView) {
      return {
        update(view, previousState) {
          if (previousState.doc !== view.state.doc) {
            onChange(view.state.doc);
          }
          if (previousState.selection !== view.state.selection) {
            onSelection(view);
          }
        },
      };
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (!suggestingRef.current || isInCodeBlock(view.state)) {
          return false;
        }

        const { insertion, deletion } = view.state.schema.marks;
        let tr = view.state.tr;
        if (from !== to) {
          tr = tr.addMark(from, to, deletion.create());
        }
        tr = tr.insertText(text, to);
        tr = tr.addMark(to, to + text.length, insertion.create());
        tr = tr.setSelection(TextSelection.create(tr.doc, to + text.length));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (!suggestingRef.current || isInCodeBlock(view.state)) {
          return false;
        }
        if (event.key !== "Backspace" && event.key !== "Delete") {
          return false;
        }

        const { selection } = view.state;
        const mark = view.state.schema.marks.deletion.create();
        let from = selection.from;
        let to = selection.to;

        if (selection.empty && event.key === "Backspace") {
          from = Math.max(1, selection.from - 1);
          to = selection.from;
        } else if (selection.empty && event.key === "Delete") {
          from = selection.from;
          to = Math.min(view.state.doc.content.size, selection.from + 1);
        }
        if (from === to) {
          return false;
        }

        event.preventDefault();
        const tr = view.state.tr.addMark(from, to, mark).setSelection(TextSelection.create(view.state.doc, to));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

function applySuggestEdit(view: EditorView, replacement: string) {
  const { from, to } = view.state.selection;
  if (from === to || isInCodeBlock(view.state) || !replacement.trim()) {
    return false;
  }
  const { deletion, insertion } = view.state.schema.marks;
  let tr = view.state.tr.addMark(from, to, deletion.create());
  tr = tr.insertText(replacement, to);
  tr = tr.addMark(to, to + replacement.length, insertion.create());
  tr = tr.setSelection(TextSelection.create(tr.doc, to + replacement.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

function applyStrike(view: EditorView) {
  const { from, to } = view.state.selection;
  if (from === to || isInCodeBlock(view.state)) {
    return false;
  }
  const tr = view.state.tr.addMark(from, to, view.state.schema.marks.deletion.create());
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

function applyComment(view: EditorView, text: string) {
  if (!text.trim()) {
    return false;
  }
  const codeBlock = findCodeBlockAtSelection(view.state);
  if (codeBlock) {
    const tr = view.state.tr.setNodeMarkup(codeBlock.pos, undefined, {
      ...codeBlock.node.attrs,
      comment: text.trim(),
    });
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }

  const { from, to } = view.state.selection;
  if (from === to) {
    return false;
  }
  const mark = view.state.schema.marks.comment.create({
    id: `c-${Date.now()}`,
    text: text.trim(),
  });
  view.dispatch(view.state.tr.addMark(from, to, mark).scrollIntoView());
  view.focus();
  return true;
}

type InlineSegment = {
  kind: "normal" | "insertion" | "deletion" | "comment";
  text: string;
  comment?: string;
};

function escapeCriticText(value: string) {
  return value.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function segmentForText(text: string, marks: readonly Mark[]): InlineSegment {
  const comment = marks.find((mark) => mark.type.name === "comment");
  const insertion = marks.some((mark) => mark.type.name === "insertion");
  const deletion = marks.some((mark) => mark.type.name === "deletion");

  if (comment) {
    return { kind: "comment", text, comment: comment.attrs.text };
  }
  if (insertion) {
    return { kind: "insertion", text };
  }
  if (deletion) {
    return { kind: "deletion", text };
  }
  return { kind: "normal", text };
}

function flattenInline(node: ProseMirrorNode): InlineSegment[] {
  const segments: InlineSegment[] = [];
  node.forEach((child) => {
    if (child.isText) {
      const next = segmentForText(child.text || "", child.marks);
      const previous = segments[segments.length - 1];
      if (previous && previous.kind === next.kind && previous.comment === next.comment) {
        previous.text += next.text;
      } else {
        segments.push(next);
      }
      return;
    }
    if (child.type.name === "hard_break") {
      segments.push({ kind: "normal", text: "\n" });
      return;
    }
    segments.push(...flattenInline(child));
  });
  return segments;
}

function renderInline(node: ProseMirrorNode) {
  const segments = flattenInline(node);
  let output = "";

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    const text = escapeCriticText(segment.text);

    if (segment.kind === "deletion" && next?.kind === "insertion") {
      output += `{~~${text}~>${escapeCriticText(next.text)}~~}`;
      index += 1;
      continue;
    }
    if (segment.kind === "deletion") {
      output += `{--${text}--}`;
      continue;
    }
    if (segment.kind === "insertion") {
      output += `{++${text}++}`;
      continue;
    }
    if (segment.kind === "comment") {
      output += `{==${text}==}{>>${escapeCriticText(segment.comment || "")}<<}`;
      continue;
    }
    output += text;
  }

  return output;
}

function indentMultiline(value: string, prefix: string) {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderListItem(node: ProseMirrorNode, marker: string) {
  const blocks: string[] = [];
  node.forEach((child) => blocks.push(renderBlock(child)));
  const continuation = " ".repeat(marker.length + 1);
  return `${marker} ${indentMultiline(blocks.join("\n"), continuation).slice(continuation.length)}`;
}

function renderBlock(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${renderInline(node)}`;
    case "paragraph":
      return renderInline(node);
    case "bullet_list": {
      const items: string[] = [];
      node.forEach((child) => {
        items.push(renderListItem(child, "-"));
      });
      return items.join("\n");
    }
    case "ordered_list": {
      const start = node.attrs.order || 1;
      const items: string[] = [];
      node.forEach((child, _offset, index) => {
        items.push(renderListItem(child, `${start + index}.`));
      });
      return items.join("\n");
    }
    case "code_block": {
      const params = node.attrs.params ? String(node.attrs.params) : "";
      const fence = `\`\`\`${params}\n${node.textContent}\n\`\`\``;
      if (node.attrs.comment) {
        return `{==${fence}==}{>>${escapeCriticText(node.attrs.comment)}<<}`;
      }
      return fence;
    }
    case "blockquote": {
      const blocks: string[] = [];
      node.forEach((child) => blocks.push(renderBlock(child)));
      return indentMultiline(blocks.join("\n\n"), "> ");
    }
    default: {
      const blocks: string[] = [];
      node.forEach((child) => blocks.push(renderBlock(child)));
      return blocks.join("\n\n");
    }
  }
}

function serializeCriticMarkdown(doc: ProseMirrorNode) {
  const blocks: string[] = [];
  doc.forEach((child) => blocks.push(renderBlock(child)));
  return blocks.join("\n\n");
}

function updatePopoverFromSelection(
  view: EditorView,
  setPopover: React.Dispatch<React.SetStateAction<PopoverState>>,
) {
  const { selection } = view.state;
  if (selection.empty || !view.hasFocus()) {
    setPopover((current) => (current.mode === "closed" ? current : emptyPopover));
    return;
  }

  const start = view.coordsAtPos(selection.from);
  const end = view.coordsAtPos(selection.to);
  setPopover({
    mode: "menu",
    top: Math.min(start.top, end.top) - 64 + window.scrollY,
    left: (start.left + end.right) / 2 + window.scrollX,
    codeBlock: isInCodeBlock(view.state),
  });
}

function App() {
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const suggestingRef = useRef(true);
  const [suggesting, setSuggesting] = useState(true);
  const [popover, setPopover] = useState<PopoverState>(emptyPopover);
  const [replacement, setReplacement] = useState("tighter priority areas");
  const [comment, setComment] = useState("Clarify owner and deadline before sending.");
  const [doc, setDoc] = useState<ProseMirrorNode>(() => makeInitialDoc());

  const serialized = useMemo(() => serializeCriticMarkdown(doc), [doc]);

  useEffect(() => {
    if (!editorHostRef.current || viewRef.current) {
      return;
    }

    const onSelection = (view: EditorView) => {
      updatePopoverFromSelection(view, setPopover);
    };

    const state = EditorState.create({
      schema: editorSchema,
      doc: makeInitialDoc(),
      plugins: [
        history(),
        keymap(baseKeymap),
        makeSuggestionPlugin(suggestingRef, setDoc, onSelection),
      ],
    });

    const view = new EditorView(editorHostRef.current, {
      state,
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        setDoc(nextState.doc);
        window.setTimeout(() => updatePopoverFromSelection(view, setPopover), 0);
      },
      attributes: {
        "aria-label": "Rendered markdown editor with suggesting mode",
      },
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    suggestingRef.current = suggesting;
  }, [suggesting]);

  const withView = (fn: (view: EditorView) => boolean) => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    if (fn(view)) {
      setPopover(emptyPopover);
      setReplacement("tighter priority areas");
      setComment("Clarify owner and deadline before sending.");
    }
  };

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">ProseMirror POC</p>
            <h1>Rendered markdown suggestions to CriticMarkup</h1>
          </div>
          <label className="suggest-toggle">
            <input
              type="checkbox"
              checked={suggesting}
              onChange={(event) => setSuggesting(event.target.checked)}
            />
            <span>Suggesting mode</span>
          </label>
        </header>

        <div className="editor-grid">
          <section className="editor-pane" aria-label="Rendered document">
            <div className="pane-head">
              <h2>Document</h2>
              <span>Select text to suggest, comment, or strike.</span>
            </div>
            <div ref={editorHostRef} className="editor-host" />
          </section>

          <aside className="output-pane" aria-label="CriticMarkup markdown output">
            <div className="pane-head">
              <h2>CriticMarkup output</h2>
              <span>Live serialization</span>
            </div>
            <pre className="critic-output">{serialized}</pre>
          </aside>
        </div>
      </section>

      {popover.mode !== "closed" && (
        <div
          className="selection-popover"
          style={{ top: popover.top, left: popover.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {popover.mode === "menu" && (
            <div className="popover-row">
              <button
                type="button"
                disabled={popover.codeBlock}
                onClick={() => setPopover((current) => ({ ...current, mode: "suggest" }))}
              >
                Suggest edit
              </button>
              <button type="button" onClick={() => setPopover((current) => ({ ...current, mode: "comment" }))}>
                Comment
              </button>
              <button type="button" disabled={popover.codeBlock} onClick={() => withView(applyStrike)}>
                Strike
              </button>
            </div>
          )}

          {popover.mode === "suggest" && (
            <form
              className="popover-form"
              onSubmit={(event) => {
                event.preventDefault();
                withView((view) => applySuggestEdit(view, replacement));
              }}
            >
              <label>
                Replacement
                <input
                  autoFocus
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                  data-testid="replacement-input"
                />
              </label>
              <button type="submit">Apply suggestion</button>
            </form>
          )}

          {popover.mode === "comment" && (
            <form
              className="popover-form"
              onSubmit={(event) => {
                event.preventDefault();
                withView((view) => applyComment(view, comment));
              }}
            >
              <label>
                Comment
                <textarea
                  autoFocus
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  data-testid="comment-input"
                />
              </label>
              <button type="submit">Attach comment</button>
            </form>
          )}
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
