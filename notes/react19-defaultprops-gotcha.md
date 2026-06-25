# React 19 drops `defaultProps` on function components

React 19 **ignores `Component.defaultProps` for function components** (deprecated in
18, removed in 19; it still works for class components). Any third‑party
React / React Native library that ships its defaults via
`Fn.defaultProps = { … }` will silently render with those props `undefined`
under React 19 — even though it worked fine on 18.

## How it bit us — mobile markdown code blocks (fixed in #116)

`react-native-syntax-highlighter`'s `NativeSyntaxHighlighter` is a **function
component** that sets its native renderer tags via `defaultProps`:

```js
NativeSyntaxHighlighter.defaultProps = {
  PreTag: ScrollView,
  CodeTag: ScrollView,
  fontFamily, fontSize,
};
```

Under React 19 those defaults are dropped, so the wrapped
`react-syntax-highlighter` fell back to its **web** defaults
(`PreTag="pre"`, `CodeTag="code"`). React Native then tried to render a `<code>`
host component and crashed:

```
Invariant Violation: View config getter callback for component `code`
must be a function (received `undefined`).
```

Every assistant message containing a code fence hit this. In production the
markdown error boundary caught it and degraded the **whole message** to plain
text; in dev it redboxed. The WS1 unit test had **mocked** `SessionMarkdown`, so
it never rendered a fence — only a real on‑device render surfaced it.

**Fix:** pass the native tags explicitly instead of relying on the library's
`defaultProps`:

```tsx
<SyntaxHighlighter highlighter="hljs" PreTag={ScrollView} CodeTag={ScrollView} … />
```

## General guidance

- When a third‑party component "loses" its defaults under React 19, suspect
  `defaultProps` on a function component. Pass those props explicitly at the
  call site, or wrap the component with the defaults applied.
- Prefer libraries that use ES default parameters / destructuring defaults
  (`function C({ x = 1 })`) over `defaultProps`.
- A component test that **mocks** a heavy child (e.g. a markdown renderer)
  cannot catch a render‑time crash inside it. Only a real render does —
  jsdom for web, a booted simulator for React Native.
