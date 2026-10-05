# light-chat

Lightweight, framework agnostic chat UI for LLM backends, in one call:

```js
new Chat("chat", { url: "/agent" });
```

- Streaming for **AG-UI** (default) and **OpenAI-compatible** (`/chat/completions`) backends, or any other through a custom connector
- Tool calls shown as compact collapsible rows, with highlighted JSON arguments and results
- Reasoning / thinking content in a collapsible block, consecutive thinking and tool call steps grouped in one line showing the running step
- Conversation history in a collapsible sidebar, stored in IndexedDB or your own store
- File attachments (button or paste), sent as multimodal content
- Optional settings menu (API key, model, effort), saved in localStorage
- Markdown rendered with [marked](https://marked.js.org), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify), code highlighted with [highlight.js](https://highlightjs.org) (common languages)
- Copy, date/time and optional thumbs up/down rating under each message
- Light/dark theme through the standard CSS `color-scheme` and `light-dark()`
- Works on desktop and mobile, zero runtime dependencies (Solid, marked, DOMPurify and highlight.js are bundled), ~72 kB gzipped
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
<script src="https://cdn.jsdelivr.net/npm/light-chat"></script>
<script>
  new LightChat.Chat("chat", { url: "/api/chat" });
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
  attachments: true, // show the + button to attach files
  history: true, // conversation history sidebar, false to disable, or your own HistoryStore
  sidebarOpen: false, // open the sidebar on first visit, then the user choice is remembered
  settings: {
    // all disabled by default, the gear button is hidden when none is enabled
    apiKey: true, // ask for an API key
    models: ["qwen-3.8", "kimi-k3"], // model picker, first is the default
    effort: ["low", "medium", "high"], // effort slider, middle is the default
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

Define a target to choose where a value goes: a `header`, a `query` parameter and/or a `body` key (dots for nested keys), with an optional `prefix`:

```js
settings: {
  apiKey: { header: "X-Api-Key" },
  models: { values: ["qwen-3.8", "kimi-k3"], query: "model" },
  effort: { values: ["low", "medium", "high"], body: "options.reasoning.effort" },
}
```

Custom `HttpConnector` subclasses can change the defaults by setting `this.settingTargets`. Connectors also receive the values in `ctx.settings`, and the targets from the options in `ctx.targets`. Note the API key is stored in plain text in the browser storage.

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

### Files

Attached files are sent as content parts of the user message: `image_url` (images) or `file` parts for OpenAI, `binary` parts for AG-UI.

### Connectors

A connector streams the assistant response for the conversation, as normalized events. Two are built in, both take `{ url, headers?, body? }`:

- **`AgUiConnector`** (default): POSTs a `RunAgentInput` (`threadId`, `runId`, `messages`, ...) and handles `TEXT_MESSAGE_*`, `REASONING_*` / `THINKING_*`, `TOOL_CALL_*` and `RUN_ERROR` events
- **`OpenAIConnector`**: POSTs `{ ...body, stream: true, messages }` and reads `choices[0].delta` (`content`, `reasoning_content` / `reasoning`, `tool_calls`)

Tool calls and their results are sent back in the history on the next turn. Tool calls without a result are left out, since backends reject unanswered calls.

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

Events: `text`, `reasoning`, `tool-start` (`id`, `name`), `tool-args` (`id`, `delta`), `tool-result` (`id`, `result`) and `error` (`message`). The `sse` parser is exported too.

## Theming

The theme follows the OS preference by default (`color-scheme: light dark` on `.lc-root`). Use `theme: "light" | "dark"` to force one, or make it follow your page `color-scheme`:

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
