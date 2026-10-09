# server

Minimal FastAPI agent demo for light-chat:

- `/mcp`: MCP server (streamable HTTP) with UniProt tools, `search_proteins` and `get_protein`, and 3 tools showing interactive widgets (MCP Apps, in [`uniprot_apps.py`](uniprot_apps.py) and [`widgets/`](widgets)):
  - `show_protein_features`: [Nightingale](https://github.com/ebi-webcomponents/nightingale) tracks of domains, sites, PTMs, processing, topology, secondary structure and variants, zoomable along the sequence. Clicking a feature shows its details and evidence
  - `show_protein_structure`: AlphaFold model colored by pLDDT, or a PDB entry, in Mol\* ([PDBe Molstar](https://github.com/molstar/pdbe-molstar)), next to the features list: clicking one highlights its residues. Residues can be highlighted from the start, e.g. a mutation
  - `search_proteins_table`: results of a UniProtKB query (up to 1000 rows) in a sortable table with facets for reviewed status, annotation score and organism. The model only gets a summary, the rows selected by the user are sent back as context, with a prompt
- `/chat`: AG-UI endpoint, a Pydantic AI agent using the MCP server tools, and the tools of remote MCP servers with interactive UIs shown in the chat:
  - [MCP-UI example server](https://remote-mcp-server-authless.idosalomon.workers.dev/mcp): task and user status (MCP-UI `ui://` resources in tool results)
  - [Excalidraw](https://mcp.excalidraw.com/mcp): diagrams drawn and edited in the chat (MCP App)
- `/`: chat UI from the [`light-chat` Python package](../packages/python/README.md)

It is part of the uv workspace defined at the repo root, which installs the Python package from `../packages/python`. Build the JS bundle and copy it in the Python package first, from the repo root:

```bash
vp run build:py
```

The agent uses an OpenAI-compatible endpoint, configured in a `.env` file:

```bash
OPENAI_API_KEY=sk-...
# Optional, the EGI endpoint by default
OPENAI_BASE_URL=https://llm.ai.egi.eu/v1
# Optional, tool calling models to pick from in the UI, the first is the default
MODELS=qwen3.8-27b,glm-5.3,kimi-k3,gpt-oss-120b
# Optional, UniProt MCP server URL, by default the one of this app is called in-process
# MCP_URL=http://localhost:8083/mcp
# Optional, remote MCP servers with tool UIs, comma separated
UI_MCP_URLS=https://remote-mcp-server-authless.idosalomon.workers.dev/mcp,https://mcp.excalidraw.com/mcp
```

Start the API:

```bash
uv run --env-file .env uvicorn app:app --port 8083 --reload
```

Open http://localhost:8083, and pick the model in the settings menu. Try "Show the domains, PTMs and variants of human AKT1", "Where is the E17K mutation of AKT1 relative to its active site? Show the structure", "Find human kinases with disease variants", "Show me the task status" or "Draw an Excalidraw diagram of a web app".

The UniProt widgets get the full data in the tool `structuredContent`, the model only gets the text summary. They load Nightingale and PDBe Molstar from jsDelivr, and structures from AlphaFold DB and PDBe, as declared in their resource CSP.

## Deploy with Docker

The image builds the chat UI and installs the server, from the repo root. With the `.env` file above (without `MCP_URL`, the agent calls the UniProt MCP server in-process), start it on http://localhost:8083:

```bash
docker compose -f server/compose.yml up -d --build
```

Or build and run the image directly:

```bash
docker build -f server/Dockerfile -t light-chat-server .
docker run -p 8083:8000 --env-file server/.env light-chat-server
```

The server listens on port 8000 in the container, and trusts `X-Forwarded-*` headers for a reverse proxy in front of it.

## Deploy on Hugging Face Spaces

[`space/deploy.sh`](space/deploy.sh) uploads the files needed to build the image to a Docker Space, created if needed, with the Dockerfile and the [Space card](space/README.md) at its root. With a write token in `HF_TOKEN` (or after `hf auth login`):

```bash
./server/space/deploy.sh # to vemonet/uniprot-agent, or pass another <owner>/<space>
```

The Space uses [OpenRouter](https://openrouter.ai) with DeepSeek V4.1 Flash and Claude Haiku 5.5 (set by the script, the local defaults stay the EGI endpoint and its models): set its API key as the `OPENAI_API_KEY` secret in the Space settings. The variables `OPENAI_BASE_URL`, `MODELS` and `UI_MCP_URLS` of the Space override the defaults. The CI deploys to [vemonet/uniprot-agent](https://huggingface.co/spaces/vemonet/uniprot-agent) on pushes to `main`, once the `HF_TOKEN` secret is set in the GitHub repo.

## How tool UIs work

Tool UIs are handled by light-chat, the server only forwards ([`light_chat.mcp_apps`](../packages/python/src/light_chat/mcp_apps.py), from the `mcp-apps` extra of the [Python package](../packages/python/README.md)): raw results of these MCP tools are sent to the chat in an `mcp-apps` activity, and widgets read their resource and call tools through `/chat` with `forwardedProps.__proxiedMCPRequest`. Tools only visible to apps are hidden from the model. The AG-UI `context` sent by the chat (e.g. a diagram edited by the user) is added to the instructions. The agent calls the UniProt MCP server of the app in-process, set `MCP_URL` to use another one over HTTP.
