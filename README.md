# light-chat

Lightweight chat UI for LLM backends, with streaming for AG-UI and OpenAI-compatible APIs, tool calls, history, attachments and settings.

| Package                                        | Description                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`light-chat`](packages/js/README.md)          | Framework agnostic: `new Chat("chat", { url })`, everything bundled, no dependencies |
| [`light-chat-solid`](packages/solid/README.md) | SolidJS component `<Chat url="..." />`, `solid-js` as peer dependency                |

All the UI and logic live in `light-chat-solid`, `light-chat` is a thin class wrapping the component.

## Development

Requires [Vite+](https://viteplus.dev) (`vp`) and pnpm.

```bash
vp install
```

Start the playground (`index.html`), with mock OpenAI and AG-UI streaming endpoints (`demo/mock.ts`):

```bash
vp dev
```

Build all packages to their `dist/`:

```bash
vp run -r build
```

Run format, lint, type checks and tests for the whole workspace:

```bash
vp check
vp test
```

In the workspace, `light-chat-solid` exports its sources, so nothing needs to be built for development. Its `publishConfig` points to `dist` when published.
