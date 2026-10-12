# light-chat

Lightweight chat UI for [AG-UI](https://docs.ag-ui.com) agents, served from a FastAPI app. It bundles the [`light-chat`](../js/README.md) JS package, no frontend build needed.

```bash
pip install light-chat
```

```python
from fastapi import FastAPI
from light_chat import chat_router

app = FastAPI()

# Chat page at `/`, sending messages to the AG-UI endpoint at `chat`, relative to the page
app.include_router(
    chat_router(
        path="/",
        url="chat",
        title="My agent",
        # Other keyword arguments are passed as options of the JS `Chat`
        welcome="## How can I help you today?",
        examples=["What can you do?"],
        settings={"models": ["gpt-5", "kimi-k3"]},
    )
)
```

The script is served next to the page: `/light-chat.js` for a page at `/`, `/ui/light-chat.js` for a page at `/ui/`.

## Tool UIs of MCP servers

With a [Pydantic AI](https://ai.pydantic.dev) agent, the interactive UIs of MCP tools ([MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) and [MCP-UI](https://mcpui.dev)) are shown in the chat. Install the `mcp-apps` extra:

```bash
pip install "light-chat[mcp-apps]"
```

Use a `UIToolset` for each MCP server with UIs, and answer the MCP requests of widgets in the AG-UI endpoint with `proxied_response`:

```python
from fastapi import FastAPI, Request, Response
from light_chat import chat_router
from light_chat.mcp_apps import PROXIED_REQUEST, UIToolset, proxied_response
from pydantic_ai import Agent
from pydantic_ai.ui.ag_ui import AGUIAdapter

# MCP servers by URL, or an `MCPServer` / `FastMCP` instance called in-process. The `id` routes widget requests
toolsets = [UIToolset("https://mcp.excalidraw.com/mcp", id="excalidraw")]
agent = Agent("openai:gpt-5", toolsets=toolsets)
app = FastAPI()


@app.post("/chat")
async def chat(request: Request) -> Response:
    body = await request.json()
    # MCP request from a widget, e.g. reading its UI resource or calling a tool of its server
    if PROXIED_REQUEST in (body.get("forwardedProps") or {}):
        return await proxied_response(body, toolsets)
    return await AGUIAdapter.dispatch_request(request, agent=agent)


app.include_router(chat_router(path="/", url="chat"))
```

The agent only forwards, the chat decides what to render:

- `UIToolset` is a Pydantic AI `MCPToolset` sending each tool result to the chat in an AG-UI `mcp-apps` activity, with the raw MCP result and the tool `_meta`. The model gets the text content of the result, tools only visible to apps (`_meta.ui.visibility`) are hidden from it, and connection errors name the server
- `proxied_response` runs `resources/read`, `tools/call` and `tools/list` requests of widgets on their server, and returns the MCP result in the `RUN_FINISHED` event. The chat only lets widgets call tools visible to apps

Widgets can also add context for the model with `ui/update-model-context`, sent as AG-UI `context` with the next request, e.g. add it to the instructions. See the [demo server](../../server/app.py) for a complete agent.

## Logging

`setup_logging` formats the logs of all libraries like uvicorn (`INFO:     message`), replacing handlers set by others, e.g. the MCP SDK. It hides the log line of each HTTP request, outgoing ones of `httpx` and the uvicorn access log, unless `request_logs=True`:

```python
from light_chat import setup_logging

setup_logging()  # or setup_logging("DEBUG", request_logs=True)
```

## Development

From the repo root, build the JS package, copy it in `src/light_chat/static`, and build the wheel in `packages/python/dist`:

```bash
vp run build:py
```
