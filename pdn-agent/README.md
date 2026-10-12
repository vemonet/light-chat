# Pathogen Data Network Agent

> Based on https://github.com/NIAID-BRC-Codeathons/federated-data-ecosystem-assistant

FastAPI app federating biological data resources through MCP servers, for light-chat:

- `/<server>/mcp`: MCP servers (streamable HTTP), in [`servers/`](servers), ported from the codeathon repo to MCP Python SDK 2:

  | Path                 | Resource                                                                                                            | Tools                                                                            |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | `/pdn/mcp`           | [Pathogen Data Network](https://pathoplexus.org) sequences and metadata through LAPIS                               | `lapis_*`, `show_lapis_*`                                                        |
  | `/uniprot/mcp`       | [UniProt](https://www.uniprot.org) proteins                                                                         | `uniprot_*`, `show_protein_*`, `show_annotation_matrix`, `search_proteins_table` |
  | `/mygene/mcp`        | [MyGene.info](https://mygene.info) gene annotation                                                                  | `mygene_*`, `show_gene_card`                                                     |
  | `/myvariant/mcp`     | [MyVariant.info](https://myvariant.info) variant annotation                                                         | `myvariant_*`, `show_variant_card`                                               |
  | `/ncbi/mcp`          | [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) and Pathogen Detection AMR isolates                | `ncbi_*`, `show_pathogen_isolates_table`, `show_amr_heatmap`                     |
  | `/pubmed/mcp`        | [PubMed](https://pubmed.ncbi.nlm.nih.gov) literature, as context only                                               | `pubmed_*`                                                                       |
  | `/geo/mcp`           | [GEO](https://www.ncbi.nlm.nih.gov/geo/) gene expression studies and their processed files                          | `geo_*`, `show_geo_series`                                                       |
  | `/nde/mcp`           | [NIAID Data Ecosystem](https://data.niaid.nih.gov) datasets and tools                                               | `nde_*`, `search_datasets_table`                                                 |
  | `/brc-analytics/mcp` | [BRC Analytics](https://brc-analytics.org) ENA sequencing runs and workflows, complementing their public MCP server | `brc_ena_*`, `show_brc_workflow_matrix`                                          |
  | `/string/mcp`        | [STRING](https://string-db.org) protein networks, complementing their public MCP server                             | `show_string_network`                                                            |

- `/chat`: AG-UI endpoint, a Pydantic AI agent using the MCP servers of the app, called in-process, and the public MCP servers of [STRING](https://mcp.string-db.org), [ExPASy](https://chat.expasy.org/mcp), [BRC Analytics](https://brc-analytics.org/api/v1/mcp/) and [Excalidraw](https://mcp.excalidraw.com/mcp). Public servers not answering are skipped, and checked again after 5 minutes
- `/`: chat UI from the [`light-chat` Python package](../packages/python/README.md)

The BV-BRC MCP server of the codeathon repo is not included, it requires an authentication.

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
# Optional, raises the NCBI rate limit from 3 to 10 requests per second
NCBI_API_KEY=
# Optional, base URL of the MCP servers used by the agent, by default the ones of this app are called in-process
# MCP_BASE_URL=http://localhost:8084
```

Start the API:

```bash
uv run --env-file .env uvicorn app:app --port 8084 --reload
```

Open http://localhost:8084, and pick the model in the settings menu. Try "How many Klebsiella pneumoniae isolates in NCBI Pathogen Detection carry a KPC carbapenemase gene?", "Which E. coli gene expression studies involve ciprofloxacin?" or "Show the domains, PTMs and variants of human AKT1".

## Provenance

The [system prompt](prompt.py) asks the model to lead with the answer, then write a `<!--PROVENANCE-->` marker, followed by the resources it chose and why, every tool call with its arguments and results, how the numbers were derived, caveats and sources. [`provenance.py`](provenance.py) sends the text after the marker as the text message of a `provenance` AG-UI sub-agent, in the same LLM response: the chat shows it collapsed below the answer, rendered as markdown, and does not send it back in the history of the next turns.

At the end of the run, the graph of the tool calls is added to this sub-agent, as an MCP App widget ([`widgets/provenance-graph.html`](widgets/provenance-graph.html)) served by a small MCP server of [`provenance.py`](provenance.py), without asking the model: the steps of the run with their parallel calls, each with its server, arguments, counts and URLs from the result, and whether it failed. Clicking a call shows its full arguments, URLs and result.

## Deploy with Docker

The image builds the chat UI and installs the agent, from the repo root. The [compose file](compose.yml) uses [OpenRouter](https://openrouter.ai) with DeepSeek V4.1 Flash (default), Mistral Large 4, Claude Haiku 5.5 and GPT-6 Luna, overriding `OPENAI_BASE_URL` and `MODELS` from the `.env` file, which holds the OpenRouter key:

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

The server listens on port 8000 in the container, and trusts `X-Forwarded-*` headers for a reverse proxy in front of it.

## How tool MCP UIs work

Tool UIs are handled by light-chat, the server only forwards ([`light_chat.mcp_apps`](../packages/python/src/light_chat/mcp_apps.py), from the `mcp-apps` extra of the [Python package](../packages/python/README.md)): raw results of the tools with a UI are sent to the chat in an `mcp-apps` activity, and widgets read their resource and call tools through `/chat` with `forwardedProps.__proxiedMCPRequest`. Tools only visible to apps are hidden from the model. The AG-UI `context` sent by the chat (e.g. a diagram edited by the user) is added to the instructions.

Widgets are in [`widgets/`](widgets), declared with their tools in the `*_apps.py` modules of each server (helpers in [`servers/apps_common.py`](servers/apps_common.py)). They get the full data in the tool `structuredContent`, while the model only gets a summary, and they do not call the APIs themselves, except to load libraries, maps and structures. Rows, cells or nodes selected by the user are sent back to the model as context, and buttons send a message about them.

PDN / LAPIS ([`servers/pdn_apps.py`](servers/pdn_apps.py)):

- `show_lapis_mutations_over_time`: frequency of mutations and lineages per period, with Wilson 95% intervals as bands and the number of sequences per period
- `show_lapis_country_map`: world map of the sequences by country ([d3](https://d3js.org) and [world-atlas](https://github.com/topojson/world-atlas)), with a ranked list
- `show_lapis_mutation_lollipop`: mutations along the genome or a gene, height by proportion, filterable by minimum proportion

NCBI Pathogen Detection ([`servers/ncbi/apps.py`](servers/ncbi/apps.py)) and NDE ([`servers/nde/apps.py`](servers/nde/apps.py)):

- `show_pathogen_isolates_table`: isolates with their AMR genes, faceted by country, year, isolation source and genes
- `show_amr_heatmap`: AMR genes by organism group, as share or count of the isolates
- `search_datasets_table`: NDE datasets faceted by repository, pathogen, species, year and technique

GEO ([`servers/geo_apps.py`](servers/geo_apps.py)) and BRC Analytics ([`servers/brc_apps.py`](servers/brc_apps.py)):

- `show_geo_series`: metadata of a series, its samples with their characteristics, and the supplementary files to download
- `show_brc_workflow_matrix`: assemblies of an organism against the BRC Analytics workflows they can run, from the public BRC Analytics MCP server

STRING ([`servers/string.py`](servers/string.py)), MyGene ([`servers/mygene_apps.py`](servers/mygene_apps.py)) and MyVariant ([`servers/myvariant_apps.py`](servers/myvariant_apps.py)):

- `show_string_network`: [Cytoscape.js](https://js.cytoscape.org) network of the proteins, edges colored by their main evidence channel, nodes by cluster
- `show_gene_card`: summary, chromosome position and gene structure, GO terms and orthologs of a gene
- `show_variant_card`: ClinVar significance, gnomAD frequencies by population and prediction scores of a variant

UniProt ([`servers/uniprot_apps.py`](servers/uniprot_apps.py)), loading structures from AlphaFold DB and PDBe:

- `show_protein_features`: [Nightingale](https://github.com/ebi-webcomponents/nightingale) tracks of domains, sites, PTMs, processing, topology, secondary structure and variants, zoomable along the sequence. Clicking a feature shows its details and evidence
- `show_protein_structure`: AlphaFold model colored by pLDDT, or a PDB entry, in Mol\* ([PDBe Molstar](https://github.com/molstar/pdbe-molstar)), next to the features list: clicking one highlights its residues. Residues can be highlighted from the start, e.g. a mutation
- `search_proteins_table`: results of a UniProtKB query (up to 1000 rows) in a sortable table with facets for reviewed status, annotation score and organism. The model only gets a summary, the rows selected by the user are sent back as context, with a prompt
- `show_protein_variants`: disease and natural variants of the [EBI Proteins API](https://www.ebi.ac.uk/proteins/api/doc/) positioned on the sequence next to the domains, in the Nightingale variation viewer, filterable by consequence, clinical significance, evidence and disease. Clicking a variant shows its links to ClinVar, dbSNP and PubMed
- `show_annotation_matrix`: heatmap of the proteins of a gene list by GO terms, keywords or Reactome pathways, shaded by GO evidence, for a quick functional overview without an enrichment tool
