# UniProt Agent

Minimal FastAPI agent demo for light-chat:

- `/mcp`: MCP server (streamable HTTP) with UniProt tools, `search_proteins` and `get_protein`, and 5 tools showing interactive widgets (MCP Apps, in [`uniprot_apps.py`](uniprot_apps.py) and [`widgets/`](widgets)):
  - `show_protein_features`: [Nightingale](https://github.com/ebi-webcomponents/nightingale) tracks of domains, sites, PTMs, processing, topology, secondary structure and variants, zoomable along the sequence. Clicking a feature shows its details and evidence
  - `show_protein_structure`: AlphaFold model colored by pLDDT, or a PDB entry, in Mol\* ([PDBe Molstar](https://github.com/molstar/pdbe-molstar)), next to the features list: clicking one highlights its residues. Residues can be highlighted from the start, e.g. a mutation
  - `search_proteins_table`: results of a UniProtKB query (up to 1000 rows) in a sortable table with facets for reviewed status, annotation score and organism. The model only gets a summary, the rows selected by the user are sent back as context, with a prompt
  - `show_protein_variants`: disease and natural variants positioned on the sequence next to the domains, in the Nightingale variation viewer, filterable by consequence, clinical significance, evidence and disease. Clicking a variant shows its links to ClinVar, dbSNP and PubMed
  - `show_annotation_matrix`: heatmap of the proteins of a gene list by GO terms, keywords or Reactome pathways, shaded by GO evidence, for a quick functional overview without an enrichment tool
- `/chat`: AG-UI endpoint, a Pydantic AI agent using the MCP server tools, and the tools of the remote [Excalidraw](https://mcp.excalidraw.com/mcp) MCP server: diagrams drawn and edited in the chat (MCP App)
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
```

Start the API:

```bash
uv run --env-file .env uvicorn app:app --port 8083 --reload
```

Open http://localhost:8083, and pick the model in the settings menu. Try "Show the domains, PTMs and variants of human AKT1", "Where is the E17K mutation of AKT1 relative to its active site? Show the structure", "Find the insulin entries of all mammals in UniProt" or "Draw an Excalidraw diagram of a web app".

## Deploy with Docker

The image builds the chat UI and installs the server, from the repo root. The [compose file](compose.yml) uses [OpenRouter](https://openrouter.ai) with DeepSeek V4.1 Flash (default), Mistral Large 4, Claude Haiku 5.5 and GPT-6 Luna, overriding `OPENAI_BASE_URL` and `MODELS` from the `.env` file, which holds the OpenRouter key:

```bash
OPENAI_API_KEY=sk-or-...
```

Without `MCP_URL`, the agent calls the UniProt MCP server in-process. Start it on http://localhost:8083, from this folder:

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

Tool UIs are handled by light-chat, the server only forwards ([`light_chat.mcp_apps`](../packages/python/src/light_chat/mcp_apps.py), from the `mcp-apps` extra of the [Python package](../packages/python/README.md)): raw results of these MCP tools are sent to the chat in an `mcp-apps` activity, and widgets read their resource and call tools through `/chat` with `forwardedProps.__proxiedMCPRequest`. Tools only visible to apps are hidden from the model. The AG-UI `context` sent by the chat (e.g. a diagram edited by the user) is added to the instructions. The agent calls the UniProt MCP server of the app in-process, set `MCP_URL` to use another one over HTTP.

The UniProt tools fetch the entry from the UniProt REST API. The widget gets the full data in the tool `structuredContent`, widgets never call UniProt, they load their structures from AlphaFold DB and PDBe.

- **Features**: the sequence and the features of each type are passed directly to the [Nightingale](https://github.com/ebi-webcomponents/nightingale) web components (`nightingale-sequence`, and `data` of each `nightingale-track`)
- **Structure**: the AlphaFold model URL (retrieved from the AlphaFold DB API) or the PDB ID (retrieved from the UniProt entry cross-references) is passed to [PDBe Molstar](https://github.com/molstar/pdbe-molstar), which downloads the structure. Features are highlighted by UniProt position, mapped to PDB residues by PDBe Molstar, or offset by the start of the AlphaFold model
- **Variants**: the variants of the [EBI Proteins API](https://www.ebi.ac.uk/proteins/api/doc/) (UniProt, ClinVar, dbSNP, gnomAD, COSMIC...) are summarized on the server, the most documented 4000 at most, and passed to `nightingale-variation-canvas`
- **Annotation matrix**: GO terms, keywords and Reactome pathways of the reviewed entries of the genes, from a single UniProt search, drawn as an HTML table
