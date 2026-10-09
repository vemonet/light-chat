---
title: UniProt agent
emoji: 🧬
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8000
pinned: false
license: mit
short_description: Chat with UniProt, with protein features and 3D views
---

# UniProt agent

Chat agent querying the [UniProt](https://www.uniprot.org) protein knowledgebase, built with [light-chat](https://github.com/vemonet/light-chat). Besides text answers, it shows interactive widgets ([MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)) in the chat:

- Sequence features: domains, sites, PTMs and variants on tracks zoomable along the sequence
- 3D structures: AlphaFold models colored by confidence, or PDB entries, with features highlighted on click
- Search results: sortable tables with facets, the rows you select are sent back to the agent

## Configuration

Set in the Space settings, they are passed to the container as environment variables:

- Secret `OPENAI_API_KEY`: [OpenRouter](https://openrouter.ai) API key
- Variable `OPENAI_BASE_URL` (optional): OpenAI-compatible endpoint, `https://openrouter.ai/api/v1` by default
- Variable `MODELS` (optional): tool calling models to pick from, comma separated, the first is the default. By default `deepseek/deepseek-v4.1-flash,anthropic/claude-haiku-5.5`
- Variable `UI_MCP_URLS` (optional): remote MCP servers with tool UIs, comma separated

This Space is deployed from the [`server/`](https://github.com/vemonet/light-chat/tree/main/server) folder of the light-chat repository, on each push to `main`.
