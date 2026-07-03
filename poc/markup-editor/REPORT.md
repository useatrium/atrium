# ProseMirror Suggesting Mode to CriticMarkup POC

## Recommendation

Use direct ProseMirror packages: `prosemirror-model`, `prosemirror-state`, `prosemirror-view`, and `prosemirror-markdown`, with custom marks and a small React shell. This was candidate (a).

This is the right first production path because the risky parts are the ProseMirror document model, selection mapping, tracked-change transactions, code-fence policy, and markdown serialization. A higher-level wrapper can still be added later, but it should wrap a core editor module that owns the schema, commands, plugins, and serializer.

I did not choose Milkdown for the POC because it adds useful product surface but also hides the exact ProseMirror behavior we needed to de-risk. I did not choose a React wrapper such as `@nytimes/react-prosemirror` for the POC because React integration was not the uncertain part; it can be layered around the direct `EditorView` once the editor core is stable.

## Deliverables

- App: `poc/markup-editor/`
- Report: `poc/markup-editor/REPORT.md`
- Screenshot evidence: `poc/markup-editor/screenshot.png`

The screenshot shows a rendered markdown document with a heading, list, paragraphs, and fenced code block. It also shows a real browser-driven replacement suggestion, deletion, inline comment, whole-code-block comment, disabled inline code-fence suggestion actions, and the live CriticMarkup output panel.

## Dependency Licensing

All direct runtime dependencies are MIT licensed:

- `prosemirror-commands`: MIT
- `prosemirror-history`: MIT
- `prosemirror-keymap`: MIT
- `prosemirror-markdown`: MIT
- `prosemirror-model`: MIT
- `prosemirror-schema-basic`: MIT
- `prosemirror-state`: MIT
- `prosemirror-view`: MIT
- `react`: MIT
- `react-dom`: MIT

Direct dev dependencies:

- `@vitejs/plugin-react`: MIT
- `vite`: MIT
- `typescript`: Apache-2.0
- `@types/react`: MIT
- `@types/react-dom`: MIT

I verified these with `npm view <package> license` on July 3, 2026. The first `npm install` and first `npm view` hit a local `~/.npm` cache permission error; rerunning with `--cache /tmp/mk703-editorpoc-npm-cache` worked. No vulnerabilities were reported by `npm audit` during install.

## What Worked

Custom marks are a clean fit for inline suggestions:

- `insertion` mark renders as green underline and serializes to `{++text++}`.
- `deletion` mark renders as red strikethrough and serializes to `{--text--}`.
- Adjacent deletion + insertion segments serialize as a CriticMarkup substitution: `{~~old~>new~~}`.
- `comment` mark renders as highlighted text with a visible note and serializes as `{==span==}{>>comment<<}`.

Selection to popover is workable with plain ProseMirror. The POC watches selection updates from an editor plugin, calls `coordsAtPos`, and positions a React popover outside the editor. The popover then dispatches ProseMirror transactions for suggest, comment, and strike.

Suggesting-mode typing is feasible. The POC intercepts `handleTextInput`; normal typing becomes an `insertion` mark, and typing over selected text marks the old range as deleted before inserting marked new text. `Backspace` and `Delete` are intercepted to mark deleted ranges instead of destructively removing content.

Markdown structure survives the POC serializer for the required sample: headings, paragraphs, lists, and fenced code blocks remain markdown, while suggestion marks become CriticMarkup.

Whole-code-block comments work as a node attribute on `code_block`, not as an inline mark. That matches the v1 rule better than allowing arbitrary inline code-fence edits.

## What Fought Back

`prosemirror-markdown` is useful for loading normal markdown, but its stock `MarkdownSerializer` is not enough for CriticMarkup substitutions. A deletion mark followed by an insertion mark needs to collapse into one `{~~old~>new~~}` token. The POC therefore uses the markdown parser for input, then a custom serializer for output.

Commenting a whole code block does not fit the same mark model as inline comments because the stock code block content disallows marks. The POC solves this with a `comment` attr on `code_block` and a special serializer path. That is acceptable, but production should make block annotations a first-class concept rather than pretending every annotation is an inline mark.

Popover selection state needs careful focus handling. Clicking form controls can steal focus from the editor and clear selection unless the popover prevents default mouse handling and commands read the last editor selection.

Serialization fidelity will need more work for full markdown. The POC handles the required structures, but production needs coverage for links, emphasis, nested lists, blockquotes, images, tables if supported, escaping edge cases, and CriticMarkup inside marked text.

## Code-Fence Policy

Inline suggestions inside code fences are disallowed in the POC. When the selection is inside a `code_block`, the popover disables `Suggest edit` and `Strike`; `Comment` promotes to a whole-block comment stored on the `code_block` node.

This is the recommended v1 behavior. It avoids corrupting code fences with inline tracked-change syntax and keeps the serialization rule simple:

```markdown
{==```ts
code
```==}{>>block comment<<}
```

## Round-Trip-In Feasibility

CriticMarkup to ProseMirror marks is feasible, but should be built as a tokenizer/parser layer, not as regex replacement after markdown parsing.

Recommended path:

1. Tokenize CriticMarkup spans before markdown parsing, preserving source offsets and token types.
2. Convert CriticMarkup into placeholder-safe markdown or directly into ProseMirror JSON.
3. Parse markdown structure with `prosemirror-markdown`.
4. Reapply marks/attrs from the token stream to the matching text ranges.

Inline tokens are straightforward: `{--x--}`, `{++x++}`, `{~~old~>new~~}`, and `{==x==}{>>note<<}` map to deletion, insertion, adjacent deletion/insertion, and comment marks. Block comments need special handling around fenced code blocks and likely should map to node attrs.

The hard cases are nesting, escaping literal CriticMarkup braces, marks crossing markdown node boundaries, and comments attached to partial list items or block boundaries. This is tractable with tests, but I would not ship it as ad hoc regex.

## React Integration Path

Recommended component boundaries for `surface/web`:

- `MarkupEditorCore`: schema, plugins, commands, serializer, parser, and transaction helpers. Framework-light TypeScript.
- `MarkupEditorReact`: owns `EditorView` lifecycle, refs, editor state bridge, and imperative command API.
- `SelectionPopover`: React UI for suggest, comment, strike, and replacement/comment fields.
- `CommentLayer`: renders inline and block comments, eventually with threaded comment IDs and resolved state.
- `CriticMarkupSerializer`: standalone module with focused tests against markdown fixtures.
- `CriticMarkupParser`: later module for round-trip-in.

I would avoid putting ProseMirror transaction logic directly inside React components. React should render controls and subscribe to state; ProseMirror should remain the source of truth for document editing.

Bundle-size note from `npm run build`: Vite produced one JS chunk at `519.43 kB` minified, `175.37 kB` gzip. That includes React and the ProseMirror stack in this isolated POC. In `surface/web`, shared React is already present, but production should still measure the editor route and consider lazy-loading the markup editor.

## Verification

Commands run:

```bash
npm install --cache /tmp/mk703-editorpoc-npm-cache
npm install --include=dev --cache /tmp/mk703-editorpoc-npm-cache
npm run build
npm run dev -- --port 5199 --strictPort
dev-browser --browser mk703-editorpoc run /tmp/mk703-editorpoc-drive.js
dev-browser --browser mk703-editorpoc run /tmp/mk703-editorpoc-shot.js
```

Build passed. The final screenshot is `poc/markup-editor/screenshot.png`.
