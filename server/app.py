"""FastAPI app exposing a UniProt MCP server, an AG-UI agent using it, and a chat UI."""

import os
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Response
from light_chat import chat_router
from light_chat.mcp_apps import PROXIED_REQUEST, UIToolset, proxied_response
from mcp.server.mcpserver import MCPServer
from pydantic_ai import Agent, RunContext
from pydantic_ai.ui.ag_ui import AGUIAdapter

from uniprot_apps import UNIPROT_API, apps, fetch_entry, get, http_client

# OpenAI-compatible endpoint, read by the OpenAI provider, with its tool calling models (the first is the default)
os.environ.setdefault("OPENAI_BASE_URL", "https://llm.ai.egi.eu/v1")
MODELS = os.getenv("MODELS", "qwen3.8-27b,glm-5.3,kimi-k3,gpt-oss-120b").split(",")
# UniProt MCP server used by the agent: the one of this app, called in-process, unless an URL is set
MCP_URL = os.getenv("MCP_URL")
# Remote MCP servers with tools displaying interactive UIs (MCP Apps and MCP-UI)
UI_MCP_URLS = os.getenv(
    # "UI_MCP_URLS", "https://remote-mcp-server-authless.idosalomon.workers.dev/mcp,https://mcp.excalidraw.com/mcp"
    "UI_MCP_URLS",
    "https://mcp.excalidraw.com/mcp",
).split(",")

# MCP server with UniProt tools, and tools showing widgets (MCP Apps) from `uniprot_apps.py`
mcp = MCPServer("uniprot", instructions="Query the UniProt protein knowledgebase", extensions=[apps])


@mcp.tool()
async def search_proteins(query: str, size: int = 5) -> list[dict[str, Any]]:
    """Search UniProtKB entries, e.g. `insulin AND organism_id:9606`, returns accession, name, genes, organism"""
    params = {
        "query": query,
        "size": size,
        "fields": "accession,protein_name,gene_names,organism_name,length",
    }
    async with http_client() as client:
        res = await get(client, f"{UNIPROT_API}/search", params)
    # Invalid queries are explained to the model, which can fix them
    if res.status_code == 400:
        raise ValueError(f"Invalid query: {', '.join(res.json().get('messages', []))}")
    res.raise_for_status()
    return [
        {
            "accession": e["primaryAccession"],
            "name": e.get("proteinDescription", {}).get("recommendedName", {}).get("fullName", {}).get("value"),
            "genes": [g["geneName"]["value"] for g in e.get("genes", []) if "geneName" in g],
            "organism": e.get("organism", {}).get("scientificName"),
            "length": e.get("sequence", {}).get("length"),
        }
        for e in res.json()["results"]
    ]


@mcp.tool()
async def get_protein(accession: str) -> dict[str, Any]:
    """Get a UniProtKB entry by accession (e.g. P01308): name, organism, function and sequence"""
    async with http_client() as client:
        e = await fetch_entry(client, accession)
    return {
        "accession": e["primaryAccession"],
        "name": e.get("proteinDescription", {}).get("recommendedName", {}).get("fullName", {}).get("value"),
        "organism": e.get("organism", {}).get("scientificName"),
        "function": [
            t["value"] for c in e.get("comments", []) if c["commentType"] == "FUNCTION" for t in c.get("texts", [])
        ],
        "sequence": e.get("sequence", {}).get("value"),
    }


# Agent using the MCP servers tools over HTTP, the model is set per request.
# Results of all tools are sent to the chat, which shows the ones with a UI
ui_toolsets = [
    UIToolset(MCP_URL or mcp, id="uniprot"),
    *(UIToolset(url, id=urlparse(url).hostname) for url in UI_MCP_URLS if url),
]
# Failed tool calls are sent back to the model a few times, e.g. to fix an invalid UniProt query
agent = Agent(toolsets=ui_toolsets, deps_type=str, retries={"tools": 3})


@agent.instructions
def instructions(ctx: RunContext[str]) -> str:
    """One system prompt (some models reject several), with the context sent by the frontend (AG-UI `context`),
    e.g. the state of a widget edited by the user"""
    prompt = (
        "You are a helpful assistant answering questions about proteins using the UniProt tools. "
        "Some tools display interactive UIs to the user, e.g. protein features, 3D structures, search results tables, "
        "task status or Excalidraw diagrams. Prefer them to show features, structures or long lists of proteins, "
        "and do not repeat in text what they show."
    )
    return f"{prompt}\n\n{ctx.deps}" if ctx.deps else prompt


# The MCP session manager must run for the whole app lifetime
@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="UniProt agent", lifespan=lifespan)


@app.post("/chat")
async def chat(request: Request) -> Response:
    """AG-UI endpoint streaming the agent response, with the model picked in `forwardedProps.model`"""
    body = await request.json()  # cached, the adapter reads the body again
    forwarded = body.get("forwardedProps") or {}
    # MCP request from a widget, e.g. reading its UI resource or calling a tool of its server
    if PROXIED_REQUEST in forwarded:
        return await proxied_response(body, ui_toolsets)
    model = forwarded.get("model") or MODELS[0]
    if model not in MODELS:
        raise HTTPException(400, f"Unknown model {model}, available: {', '.join(MODELS)}")
    context = "\n\n".join(f"{c['description']}:\n{c['value']}" for c in body.get("context") or [])
    return await AGUIAdapter.dispatch_request(request, agent=agent, model=f"openai-chat:{model}", deps=context)


@app.get("/models")
async def models() -> list[str]:
    """Models available for `/chat`"""
    return MODELS


# Chat UI at `/`, the model picked in the settings is sent in `forwardedProps.model`
app.include_router(
    chat_router(
        path="/",
        url="/chat",
        title="UniProt agent",
        settings={"models": MODELS},
        welcome=(
            "## Ask about proteins\nThe agent queries [UniProt](https://www.uniprot.org), "
            "and shows interactive sequence features, 3D structures and results tables."
        ),
        placeholder="Ask a question",
        examples=[
            "What is the function of human insulin?",
            "Which proteins are involved in the human circadian clock?",
            "Show the domains, PTMs and variants of human AKT1",
            "Where is the E17K mutation of AKT1 relative to its active site? Show the structure",
            "Find human kinases with disease variants",
            "Look up human insulin, IRS1 and GLUT4 in UniProt, then draw an Excalidraw diagram of the insulin signaling pathway",
            # "Look up human insulin, the insulin receptor, IRS1 and GLUT4 in UniProt, then draw an Excalidraw diagram of the insulin signaling pathway: one box per protein with its accession, gene name and length, and arrows showing how the signal flows to glucose uptake, based on their UniProt function descriptions.",
            # add AKT between IRS1 and GLUT4, look it up in UniProt first
        ],
    )
)
# Mounted last at the root: it serves `/mcp` and would otherwise shadow the routes above
app.mount("/", mcp.streamable_http_app(stateless_http=True, json_response=True))
