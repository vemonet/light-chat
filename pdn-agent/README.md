# Pathogen Data Network Agent

> Based on https://github.com/NIAID-BRC-Codeathons/federated-data-ecosystem-assistant

FastAPI app federating biological data resources through MCP servers, for light-chat:

- `/mcp`: the Pathogen Data Network MCP server (streamable HTTP) of [`mcp_servers/server.py`](mcp_servers/server.py), with the tools of each resource in their own module of [`mcp_servers/`](mcp_servers), ported from the codeathon repo to MCP Python SDK 2:

  | Source          | Resource                                                                                                            | Tools                                                        |
  | --------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
  | `pdn`           | [Pathogen Data Network](https://pathoplexus.org) sequences and metadata through LAPIS                               | `lapis_*`, `show_lapis_*`                                    |
  | `mygene`        | [MyGene.info](https://mygene.info) gene annotation                                                                  | `mygene_*`, `show_gene_card`                                 |
  | `myvariant`     | [MyVariant.info](https://myvariant.info) variant annotation                                                         | `myvariant_*`, `show_variant_card`                           |
  | `ncbi`          | [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) and Pathogen Detection AMR isolates                | `ncbi_*`, `show_pathogen_isolates_table`, `show_amr_heatmap` |
  | `pubmed`        | [PubMed](https://pubmed.ncbi.nlm.nih.gov) literature, as context only                                               | `pubmed_*`                                                   |
  | `geo`           | [GEO](https://www.ncbi.nlm.nih.gov/geo/) gene expression studies and their processed files                          | `geo_*`, `show_geo_series`                                   |
  | `nde`           | [NIAID Data Ecosystem](https://data.niaid.nih.gov) datasets and tools                                               | `nde_*`, `search_datasets_table`                             |
  | `brc-analytics` | [BRC Analytics](https://brc-analytics.org) ENA sequencing runs and workflows, complementing their public MCP server | `brc_ena_*`, `show_brc_workflow_matrix`                      |
  | `string`        | [STRING](https://string-db.org) protein networks, complementing their public MCP server                             | `show_string_network`                                        |

- `/chat`: AG-UI endpoint, a Pydantic AI agent using the MCP server of the app, called in-process, and the public MCP servers of [STRING](https://mcp.string-db.org), [ExPASy](https://chat.expasy.org/mcp) (SPARQL over SIB resources, and the UniProt tools and widgets), [BRC Analytics](https://brc-analytics.org/api/v1/mcp/) and [Excalidraw](https://mcp.excalidraw.com/mcp). Their sessions are opened at startup and kept open, a server not answering then is skipped until the app restarts
- `/info`: models available for `/chat` with their effort levels, and the MCP servers of the agent with their number of tools as read at startup (`null` for a server not answering then), listed from a button in the chat toolbar and used as healthcheck
- `/`: chat UI from the [`light-chat` Python package](../packages/python/README.md)

The BV-BRC MCP server of the codeathon repo is not included, it requires an authentication.

It is part of the uv workspace defined at the repo root, which installs the Python package from `../packages/python`. Build the JS bundle and copy it in the Python package, and bundle the widgets, first, from the repo root (`vp run pdn` does both before starting the app):

```bash
vp run build:py
vp run --filter pdn-agent build
```

The agent uses an OpenAI-compatible endpoint, configured in a `.env` file:

```bash
OPENAI_API_KEY=sk-...
# Optional, OpenRouter by default
OPENAI_BASE_URL=https://openrouter.ai/api/v1
# Optional, tool calling models to pick from in the UI, the first is the default. Comma-separated names,
# or a JSON list to set the reasoning effort levels of each model, lowest first (no effort slider without levels)
MODELS='[{"name": "deepseek/deepseek-v4.1-flash-1017", "effort": ["none", "low", "high", "max"], "default_effort": "high"}, "mistralai/mistral-large-4-0"]'
# Optional, raises the NCBI rate limit from 3 to 10 requests per second
NCBI_API_KEY=
# Optional, public hostnames behind a reverse proxy, accepted by the MCP server besides localhost
# ALLOWED_HOSTS=pdn.example.org
```

Start the API:

```bash
uv run --env-file .env uvicorn app:app --port 8084 --reload
```

Open http://localhost:8084, and pick the model and its reasoning effort in the settings menu. Try "How many Klebsiella pneumoniae isolates in NCBI Pathogen Detection carry a KPC carbapenemase gene?", "Which E. coli gene expression studies involve ciprofloxacin?" or "Show the domains, PTMs and variants of human AKT1".

## Provenance

The [system prompt](prompt.py) asks the model to lead with the answer, then write a `<!--PROVENANCE-->` marker, followed by the resources it chose and why, every tool call with its arguments and results, how the numbers were derived, caveats and sources. [`provenance.py`](mcp_servers/provenance.py) sends the text after the marker as the text message of a `provenance` AG-UI sub-agent, in the same LLM response: the chat shows it collapsed below the answer, rendered as markdown, and does not send it back in the history of the next turns.

At the end of the run, the graph of the tool calls is added to this sub-agent, as an MCP App widget ([`mcp_servers/widgets/provenance-graph.html`](mcp_servers/widgets/provenance-graph.html)) served by a small MCP server of [`provenance.py`](mcp_servers/provenance.py), without asking the model: the steps of the run with their parallel calls, each with its server, arguments, counts and URLs from the result, and whether it failed. Clicking a call shows its full arguments, URLs and result.

## Deploy with Docker

The image builds the chat UI and installs the agent, from the repo root. The agent uses [OpenRouter](https://openrouter.ai) by default, with DeepSeek V4.1 Flash (default), Mistral Large 4, Claude Haiku 5.5 and GPT-6 Luna. The [compose file](compose.yml) forces the OpenRouter `OPENAI_BASE_URL` over the `.env` file, which holds the OpenRouter key:

```bash
OPENAI_API_KEY=sk-or-...
```

Start it on http://localhost:8084, from this folder:

```bash
docker compose up -d --build
```

Or build and run the image directly:

```bash
docker build -f pdn-agent/Dockerfile -t pdn-agent .
docker run -p 8084:8000 --env-file pdn-agent/.env pdn-agent
```

The server listens on port 8000 in the container, and trusts `X-Forwarded-*` headers for a reverse proxy in front of it. Set `ALLOWED_HOSTS` to the public hostname, otherwise the MCP server rejects proxied requests with `Invalid Host header` (DNS rebinding protection of the MCP SDK).

## How tool MCP UIs work

Tool UIs are handled by light-chat, the server only forwards ([`light_chat.mcp_apps`](../packages/python/src/light_chat/mcp_apps.py), from the `mcp-apps` extra of the [Python package](../packages/python/README.md)): raw results of the tools with a UI are sent to the chat in an `mcp-apps` activity, and widgets read their resource and call tools through `/chat` with `forwardedProps.__proxiedMCPRequest`. Tools only visible to apps are hidden from the model. The AG-UI `context` sent by the chat (e.g. a diagram edited by the user) is added to the instructions.

Widgets are in [`mcp_servers/widgets/`](mcp_servers/widgets), declared with their tools in the `*_apps.py` modules of each resource, on the MCP Apps extension of [`mcp_servers/apps_common.py`](mcp_servers/apps_common.py) with the helpers. Each widget is bundled by Vite with its scripts, styles and npm dependencies (MCP Apps SDK, d3, Cytoscape.js...) in one HTML file in `mcp_servers/widgets/dist/` ([`build-widgets.js`](build-widgets.js)), so they load nothing from a CDN. They get the full data in the tool `structuredContent`, while the model only gets a summary, and they do not call the APIs themselves. Rows, cells or nodes selected by the user are sent back to the model as context, and buttons send a message about them.

PDN / LAPIS ([`mcp_servers/pdn_apps.py`](mcp_servers/pdn_apps.py)):

- `show_lapis_mutations_over_time`: frequency of mutations and lineages per period, with Wilson 95% intervals as bands and the number of sequences per period
- `show_lapis_country_map`: world map of the sequences by country ([d3](https://d3js.org) and [world-atlas](https://github.com/topojson/world-atlas)), with a ranked list
- `show_lapis_mutation_lollipop`: mutations along the genome or a gene, height by proportion, filterable by minimum proportion

NCBI Pathogen Detection ([`mcp_servers/ncbi/apps.py`](mcp_servers/ncbi/apps.py)) and NDE ([`mcp_servers/nde/apps.py`](mcp_servers/nde/apps.py)):

- `show_pathogen_isolates_table`: isolates with their AMR genes, faceted by country, year, isolation source and genes
- `show_amr_heatmap`: AMR genes by organism group, as share or count of the isolates
- `search_datasets_table`: NDE datasets faceted by repository, pathogen, species, year and technique

GEO ([`mcp_servers/geo_apps.py`](mcp_servers/geo_apps.py)) and BRC Analytics ([`mcp_servers/brc_analytics_apps.py`](mcp_servers/brc_analytics_apps.py)):

- `show_geo_series`: metadata of a series, its samples with their characteristics, and the supplementary files to download
- `show_brc_workflow_matrix`: assemblies of an organism against the BRC Analytics workflows they can run, from the public BRC Analytics MCP server

STRING ([`mcp_servers/string_apps.py`](mcp_servers/string_apps.py)), MyGene ([`mcp_servers/mygene_apps.py`](mcp_servers/mygene_apps.py)) and MyVariant ([`mcp_servers/myvariant_apps.py`](mcp_servers/myvariant_apps.py)):

- `show_string_network`: [Cytoscape.js](https://js.cytoscape.org) network of the proteins, edges colored by their main evidence channel, nodes by cluster
- `show_gene_card`: summary, chromosome position and gene structure, GO terms and orthologs of a gene
- `show_variant_card`: ClinVar significance, gnomAD frequencies by population and prediction scores of a variant
