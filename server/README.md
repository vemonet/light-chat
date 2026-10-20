# UniProt Agent

Minimal FastAPI agent demo for light-chat:

- `/chat`: AG-UI endpoint, a Pydantic AI agent using the tools of 2 remote MCP servers:
  - [ExPASy](https://chat.expasy.org/mcp) (from [sparql-llm](https://github.com/sib-swiss/sparql-llm)): UniProt tools, with interactive widgets (MCP Apps) showing protein features, 3D structures, variants, annotation matrices, interaction networks and search results tables, and SPARQL queries over UniProt, Rhea, Bgee and other SIB resources
  - [Excalidraw](https://mcp.excalidraw.com/mcp): diagrams drawn and edited in the chat (MCP App)
- `/`: chat UI from the [`light-chat` Python package](../packages/python/README.md)

It is part of the uv workspace defined at the repo root, which installs the Python package from `../packages/python`. Build the JS bundle and copy it in the Python package first, from the repo root:

```bash
vp run build:py
```

The agent uses an OpenAI-compatible endpoint, configured in a `.env` file:

```bash
OPENAI_API_KEY=sk-...
# Optional, OpenRouter by default
OPENAI_BASE_URL=https://openrouter.ai/api/v1
# Optional, tool calling models to pick from in the UI, the first is the default
MODELS=deepseek/deepseek-v4.1-flash-1017,mistralai/mistral-large-4-0,anthropic/claude-haiku-5.5,openai/gpt-6-luna
```

Start the API:

```bash
uv run --env-file .env uvicorn app:app --port 8083 --reload
```

Open http://localhost:8083, and pick the model in the settings menu. Try "Show the domains, PTMs and variants of human AKT1", "Where is the E17K mutation of AKT1 relative to its active site? Show the structure", "Find the insulin entries of all mammals in UniProt" or "Draw an Excalidraw diagram of a web app".

## Deploy with Docker

The image builds the chat UI and installs the server, from the repo root. The server uses [OpenRouter](https://openrouter.ai) by default, with DeepSeek V4.1 Flash (default), Mistral Large 4, Claude Haiku 5.5 and GPT-6 Luna. The [compose file](compose.yml) forces the OpenRouter `OPENAI_BASE_URL` over the `.env` file, which holds the OpenRouter key:

```bash
OPENAI_API_KEY=sk-or-...
```

Start it on http://localhost:8083, from this folder:

```bash
docker compose up -d --build
```

Or build and run the image directly:

```bash
docker build -f server/Dockerfile -t light-chat-server .
docker run -p 8083:8000 --env-file server/.env light-chat-server
```

The server listens on port 8000 in the container, and trusts `X-Forwarded-*` headers for a reverse proxy in front of it.

## How tool MCP UIs work

Tool UIs are handled by light-chat, the server only forwards ([`light_chat.mcp_apps`](../packages/python/src/light_chat/mcp_apps.py), from the `mcp-apps` extra of the [Python package](../packages/python/README.md)): raw results of these MCP tools are sent to the chat in an `mcp-apps` activity, and widgets read their resource and call tools through `/chat` with `forwardedProps.__proxiedMCPRequest`. Tools only visible to apps are hidden from the model. The AG-UI `context` sent by the chat (e.g. a diagram edited by the user) is added to the instructions.
