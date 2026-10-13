# light-chat

A lightweight and framework-agnostic chat UI for LLM agents, for [AG-UI](https://docs.ag-ui.com) or OpenAI-compatible endpoints, with the clean, modern look of recent agent apps like Claude Code and Codex.

```html
<div id="chat" style="height: 100vh"></div>
<script type="module">
  import { Chat } from "https://cdn.jsdelivr.net/npm/light-chat";

  new Chat("chat", { url: "/agent" });
</script>
```

- **Framework agnostic**: one class mounted on a DOM element. Use it in plain HTML, React, Vue, Svelte, Angular, or a page served by FastAPI, Django or Express
- **Easy to deploy**: a single ~79 kB gzipped file, as an ES module or a [classic script](packages/js/README.md#install). Load it from a CDN, or copy it to your backend static folder
- **Made for agents**: streams text, reasoning, tool calls, sub-agents, steps and activity updates, and shows interactive tool UIs from [MCP Apps](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/) and MCP-UI servers. They show as compact collapsible rows, sub-agents nest their own content, and consecutive steps are grouped in one line showing the running step
- **Complete out of the box**: conversation history (IndexedDB or your own store), file attachments, model / effort / API key settings, markdown with code highlighting, copy and rating buttons, light and dark themes, desktop and mobile
- **Open to any backend**: [AG-UI](https://docs.ag-ui.com) and OpenAI connectors are built in, writing a connector for anything else (custom SSE, WebSocket, SDK, local model) takes a few lines
- **Easy to restyle**: all colors, fonts and sizes are CSS variables

## Packages

| Package                                        | Description                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| [`light-chat`](packages/js/README.md)          | Framework agnostic: `new Chat("chat", { url })`, everything bundled            |
| [`light-chat-solid`](packages/solid/README.md) | SolidJS component `<Chat url="..." />`, for Solid apps, `solid-js` as peer dep |

The UI is written with [SolidJS](https://www.solidjs.com), which compiles to small and fast DOM code. `light-chat` bundles it, so you never deal with it unless you build a Solid app yourself.

See the [`light-chat` documentation](packages/js/README.md) for all options: connectors, settings, history, attachments and theming.

## Install

```bash
npm i --save light-chat
```

```js
import { Chat, OpenAIConnector } from "light-chat";

const chat = new Chat("chat", {
  connector: new OpenAIConnector({ url: "/v1/chat/completions" }),
  welcome: "## How can I help you today?",
  examples: ["What can you do?", "Summarize this document"],
  settings: { models: ["qwen-3.8", "kimi-k3"], effort: ["low", "medium", "high"] },
});
```

In a framework, mount it like any other DOM widget, e.g. with React:

```jsx
function Assistant() {
  const ref = useRef(null);
  useEffect(() => {
    const chat = new Chat(ref.current, { url: "/agent" });
    return () => chat.destroy();
  }, []);
  return <div ref={ref} style={{ height: "100vh" }} />;
}
```

## Example agent

[`server/`](server/README.md) contains a minimal full-stack example: a FastAPI app serving a [Pydantic AI](https://ai.pydantic.dev) agent over AG-UI, using tools from an MCP server, with light-chat as its UI.

The [`light-chat` Python package](packages/python/README.md) serves the chat UI from a FastAPI route, without frontend build.

## Development

Requires [Vite+](https://viteplus.dev) (`vp`) and pnpm.

```bash
vp i
```

Start the playground (`index.html`). Requests to `api/openai` and `api/agui` are answered in the browser by a mock streaming backend (`demo/mock.ts`), so the demo also works as a static site:

```bash
vp dev
```

Build all packages to their `dist/`:

```bash
vp run -r build
```

Build the demo to `dist/` as a static site:

```bash
vp build
```

Run format, lint, type checks and tests for the whole workspace:

```bash
vp check && vp test
uvx ruff check --fix && uvx ruff format && uvx ty check
```

Tests are split in 3 projects, defined in the root `vite.config.ts`:

- `unit`: connectors and stream parsing in Node (`packages/*/tests/*.test.ts`)
- `browser`: the `Chat` class and its UI in a real headless Chromium (`packages/*/tests/*.browser.test.ts`)
- `e2e`: builds the demo, serves it under a sub path like GitHub Pages and drives it as a user would (`tests/`)

The browser and e2e projects need Chromium for Playwright, install it once with:

```bash
vp exec playwright install chromium
```

Run a single project with `vp test --project e2e`.

Release new version:

```sh
vp run release
```

The [CI workflow](.github/workflows/ci.yml) runs the checks, tests and builds on each push and pull request, and deploys the demo to GitHub Pages on pushes to `main`.

In the workspace, `light-chat-solid` exports its sources, so nothing needs to be built for development. Its `publishConfig` points to `dist` when published. All the UI and logic live in `light-chat-solid`, `light-chat` is a thin class wrapping the component.
