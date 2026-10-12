# light-chat

Lightweight, framework agnostic chat UI for LLM backends, in one call:

```js
new Chat("chat", { url: "/agent" });
```

- Streaming for **AG-UI** (default) and **OpenAI-compatible** (`/chat/completions`) backends, or any other through a custom connector
- Tool calls shown as compact collapsible rows, with highlighted JSON arguments and results
- Reasoning / thinking content in a collapsible block, consecutive thinking and tool call steps grouped in one line showing the running step
- AG-UI sub-agents shown as collapsible rows with their own nested content, plus run steps and activity updates
- Interactive tool UIs from [MCP Apps](https://modelcontextprotocol.io/extensions/apps) and [MCP-UI](https://mcpui.dev) servers, in sandboxed iframes
- Conversation history in a collapsible sidebar with search, stored in IndexedDB or your own store
- File attachments (button or paste), sent as multimodal content
- Optional settings in the toolbar under the input box (model, effort, API key), saved in localStorage
- Markdown rendered with [marked](https://marked.js.org), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify), code highlighted with [highlight.js](https://highlightjs.org) (common languages and SPARQL)
- Copy, date/time and optional thumbs up/down rating under each message
- Light/dark theme through the standard CSS `color-scheme` and `light-dark()`
- Works on desktop and mobile, zero runtime dependencies (Solid, marked, DOMPurify and highlight.js are bundled), ~79 kB gzipped
- Also available as a SolidJS component: [`light-chat-solid`](../solid/README.md)

## Install

```bash
npm install light-chat
```

```js
import { Chat } from "light-chat";
```

Or without a bundler:

```html
<script type="module">
  import { Chat } from "https://cdn.jsdelivr.net/npm/light-chat";

  new Chat("chat", { url: "/api/chat" });
</script>
```

A classic script build is also provided, it exposes the `Chat` global, with the connectors attached to it (e.g. `Chat.OpenAIConnector`):

```html
<script src="https://cdn.jsdelivr.net/npm/light-chat/dist/index.iife.js"></script>
<script>
  new Chat("chat", { url: "/api/chat" });
</script>
```

## Usage

The chat fills its container, give it a height:

```html
<div id="chat" style="height: 100vh"></div>
```

```js
import { Chat, OpenAIConnector } from "light-chat";

const chat = new Chat("chat", {
  // backend connector, default: AG-UI connector on `url`
  connector: new OpenAIConnector({
    url: "https://api.openai.com/v1/chat/completions",
    headers: { "X-Custom": "value" }, // or a (async) function returning headers
    body: { temperature: 0.7 }, // extra fields merged in the request body
  }),
  // url: "/agent", // shortcut for `connector: new AgUiConnector({ url: "/agent" })`
  welcome: "## How can I help you today?", // markdown shown when empty
  examples: ["What can you do?", "Summarize this document"], // example questions shown when empty, sent on click
  placeholder: "Send a message",
  theme: "auto", // "auto" (OS preference) | "light" | "dark"
  themeSwitch: false, // button in the sidebar to switch between system, light and dark, the user choice is remembered
  attachments: true, // show the + button to attach files
  history: true, // conversation history sidebar, false to disable, or your own HistoryStore
  sidebarOpen: false, // open the sidebar on first visit, then the user choice is remembered
  urlParam: "session", // open conversation id kept in the URL (?session=ID) and opened on load, false to disable
  settings: {
    // all disabled by default, each enabled one is shown in the toolbar under the input box
    models: ["qwen-3.8", "kimi-k3"], // model menu, first is the default
    effort: ["low", "medium", "high"], // effort slider, middle is the default
    apiKey: true, // API key input
  },
  onRate: (message, rating) => console.log(rating, message), // shows thumbs up/down, rating is "up" | "down" | null
  onError: (error) => console.error(error),
});

chat.send("Hello"); // send a message programmatically, optionally with files as 2nd argument
chat.stop(); // abort the current response
chat.clear(); // start a new conversation
chat.open(id); // open a conversation from the history
chat.conversationId; // id of the current conversation, sent as AG-UI threadId
chat.messages; // current messages
chat.destroy(); // unmount
```

The first argument is an element id (with or without `#`) or an `HTMLElement`.

### Settings

Settings chosen by the user are saved in `localStorage` (key `light-chat-settings`) and added to each request. By default:

| Setting | `OpenAIConnector`             | `AgUiConnector`               |
| ------- | ----------------------------- | ----------------------------- |
| API key | `Authorization: Bearer <key>` | `Authorization: Bearer <key>` |
| Model   | body `model`                  | body `forwardedProps.model`   |
| Effort  | body `reasoning_effort`       | body `forwardedProps.effort`  |

Pass an `apply` callback to change how a value is added to the request. It receives the request (`url` as a `URL`, `headers` and `body` objects) and the value:

```js
settings: {
  apiKey: { apply: (req, key) => (req.headers["X-Api-Key"] = key) },
  models: { values: ["qwen-3.8", "kimi-k3"], apply: (req, model) => req.url.searchParams.set("model", model) },
  effort: { values: ["low", "medium", "high"], apply: (req, effort) => (req.body.reasoning = { effort }) },
}
```

Custom `HttpConnector` subclasses can change the defaults by setting `this.applySettings`. Connectors also receive the values in `ctx.settings`, and the callbacks from the options in `ctx.apply`. Note the API key is stored in plain text in the browser storage.

### History

Conversations are listed in a sidebar (closed on first visit unless `sidebarOpen: true`, then the user choice is remembered per browser) and saved in IndexedDB after each message and response. The title is the start of the first user message.

To use your own API or database, pass an object implementing `HistoryStore`, or extend `IndexedDBHistory` to keep a local copy:

```ts
import { Chat, IndexedDBHistory, type Conversation } from "light-chat";

class SyncedHistory extends IndexedDBHistory {
  async save(conversation: Conversation) {
    await super.save(conversation);
    await fetch("/api/conversations", { method: "POST", body: JSON.stringify(conversation) });
  }
}

new Chat("chat", { url: "/agent", history: new SyncedHistory() });
```

`HistoryStore` methods: `list()` (summaries `{ id, title, updatedAt }`, most recent first), `get(id)`, `save(conversation)` and `delete(id)`.

The search button in the sidebar is shown when the store has an optional `search(query)` method, returning one hit per matching message, `{ conversationId, title, messageId, snippet }`. Opening a hit opens the conversation with the query highlighted in that message. `IndexedDBHistory` searches the text of all its conversations, a custom store can call its API, or reuse the default matching with `searchConversations(conversations, query)`:

```ts
const history: HistoryStore = {
  // list, get, save, delete...
  async search(query) {
    const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(query)}`);
    return res.json();
  },
};
```

### Files

Attached files are sent as content parts of the user message: `image_url` (images) or `file` parts for OpenAI, `image` / `audio` / `video` / `document` parts for AG-UI.

### Connectors

A connector streams the assistant response for the conversation, as normalized events. Two are built in, both take `{ url, headers?, body? }`:

- **`AgUiConnector`** (default): POSTs a `RunAgentInput` (`threadId`, `runId`, `messages`, ...) and handles `TEXT_MESSAGE_*`, `REASONING_*` / `THINKING_*`, `TOOL_CALL_*`, `STEP_*`, `SUBAGENT_*` (events tagged with `subagentRunId` are nested in their sub-agent), `ACTIVITY_*`, `STATE_*` and `RUN_ERROR` events. The agent state is kept with the answer and sent back in the next request. Pass `onEvent` to receive every raw event, e.g. for `CUSTOM` events or interrupts in `RUN_FINISHED`
- **`OpenAIConnector`**: POSTs `{ ...body, stream: true, messages }` and reads `choices[0].delta` (`content`, `reasoning_content` / `reasoning`, `tool_calls`)

Tool calls and their results are sent back in the history on the next turn. Tool calls without a result are left out, since backends reject unanswered calls.

### Tool UIs (MCP Apps and MCP-UI)

Tool results with an interactive UI are shown in a sandboxed iframe under the tool call. With AG-UI the agent sends an `ACTIVITY_SNAPSHOT` of type `mcp-apps` after the tool result, with the raw MCP result: `{ result, toolInput, serverId, tool: { name, _meta } }`, or `{ result, toolInput, serverHash, resourceUri }` from the [AG-UI MCP Apps middleware](https://github.com/ag-ui-protocol/ag-ui/tree/main/middlewares/mcp-apps-middleware). The chat decides what to show, results without UI are hidden:

- **MCP Apps**: a tool with `_meta.ui.resourceUri`. The `text/html;profile=mcp-app` resource runs with a Content Security Policy built from its `_meta.ui.csp`, and talks to the chat over the MCP Apps JSON-RPC protocol: tool input and result, `tools/call` and `resources/read` on its server, `ui/message`, `ui/open-link`, `ui/update-model-context` (sent as AG-UI `context` with the next messages), `ui/request-display-mode` (inline or full screen) and size changes
- **MCP-UI**: `ui://` resources embedded in the tool result, as HTML (`text/html`) or an external page (`text/uri-list`), with `tool`, `prompt`, `intent`, `link` and size change actions. Remote DOM resources are not supported

The widget reads its resource and calls tools through `connector.mcpRequest()`. `AgUiConnector` sends it to the agent endpoint in `forwardedProps.__proxiedMCPRequest` (`{ serverHash, serverId, method, params }` with `resources/read`, `tools/call` or `tools/list`), the agent runs it on the MCP server and returns the MCP result as the `RUN_FINISHED` result. Widgets can only call tools visible to apps (`_meta.ui.visibility`), checked with `tools/list`. See [`light_chat.mcp_apps`](../python/README.md#tool-uis-of-mcp-servers) in the Python package for a Pydantic AI implementation, MCP servers usually can not be reached from the browser directly (CORS, credentials).

HTML from tools runs in an opaque origin (`sandbox="allow-scripts allow-forms"`), so it can not reach the page, its cookies or storage. External MCP-UI pages keep their own origin.

### Custom connector

For a backend that POSTs JSON and streams Server-Sent Events, extend `HttpConnector`: it handles the request, headers, API key, errors and SSE parsing, you define the `body()` and how to `parse()` the events. `toTurns()` flattens the conversation (text, files, tool calls and results) to map it to your format:

```ts
import { Chat, HttpConnector, toTurns, type ChatEvent, type ConnectorContext } from "light-chat";

class MyConnector extends HttpConnector {
  protected body(ctx: ConnectorContext) {
    return { model: ctx.settings.model, history: toTurns(ctx.messages) };
  }

  protected async *parse(data: AsyncIterable<string>): AsyncGenerator<ChatEvent> {
    for await (const payload of data) yield { type: "text", delta: JSON.parse(payload).text };
  }
}

new Chat("chat", { connector: new MyConnector({ url: "/my/api" }) });
```

Built-in connectors can be extended the same way, e.g. to override `body()` or `headers()`. For anything else (WebSocket, SDK, local model) implement the `Connector` interface:

```ts
const connector: Connector = {
  async *stream({ messages, settings, signal, threadId }) {
    yield { type: "text", delta: "Hello" };
  },
};
```

Events: `text`, `reasoning`, `tool-start` (`id`, `name`), `tool-args` (`id`, `delta`), `tool-result` (`id`, `result`), `step-start` / `step-end` (`name`), `subagent-start` (`id`, `name`, `description`), `subagent-end` (`id`, `result`, `error`), `activity` (`id`, `activityType`, `content`), `state` (`state`) and `error` (`message`). Add `subagent: id` to an event to nest it in that sub-agent. The `sse` parser is exported too.

## Theming

The theme follows the OS preference by default (`color-scheme: light dark` on `.lc-root`). Use `theme: "light" | "dark"` to force one, `themeSwitch: true` to let the user pick it from a button in the sidebar (saved in localStorage, overrides `theme`, the current one is in the `data-theme` attribute of `.lc-root`), or make it follow your page `color-scheme`:

```css
.lc-root {
  color-scheme: inherit;
}
```

All colors and sizes are CSS variables you can override, using `light-dark()` to set both themes:

```css
.lc-root {
  --lc-accent: light-dark(#2563eb, #60a5fa);
  --lc-bg: transparent;
  --lc-font: "Inter", sans-serif;
  --lc-max-width: 900px;
}
```

Available: `--lc-bg`, `--lc-fg`, `--lc-muted`, `--lc-surface`, `--lc-input-bg`, `--lc-border`, `--lc-border-strong`, `--lc-hover`, `--lc-accent`, `--lc-link`, `--lc-error`, `--lc-code-bg`, `--lc-font`, `--lc-mono`, `--lc-radius`, `--lc-max-width`.
