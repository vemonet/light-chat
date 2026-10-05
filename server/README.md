# server

Minimal FastAPI agent demo for light-chat:

- `/mcp`: MCP server (streamable HTTP) with 2 UniProt tools, `search_proteins` and `get_protein`
- `/chat`: AG-UI endpoint, a Pydantic AI agent using the MCP server tools
- `/`: chat UI using light-chat

Build light-chat first, from the repo root (served from `../packages/js/dist`):

```bash
vp run --filter light-chat build
```

The agent uses an OpenAI-compatible endpoint, configured in a `.env` file:

```bash
OPENAI_BASE_URL=https://llm.ai.egi.eu/v1
OPENAI_API_KEY=sk-...
# Optional, tool calling models to pick from in the UI, the first is the default
MODELS=qwen3.8-27b,glm-5.3,kimi-k3,gpt-oss-120b
```

Start the API:

```bash
uv run --env-file .env uvicorn app:app --port 8083 --reload
```

Open http://localhost:8083, and pick the model in the settings menu. The agent reaches the MCP tools at `MCP_URL` (default `http://localhost:8000/mcp`), set it to match the host and port, here `http://localhost:8083/mcp`.
