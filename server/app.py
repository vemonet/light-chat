"""FastAPI app exposing a UniProt MCP server, an AG-UI agent using it, and a chat UI."""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx2
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.mcpserver import MCPServer
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.ui.ag_ui import AGUIAdapter

# Tool calling models served by the OpenAI-compatible endpoint set in `OPENAI_BASE_URL`, the first is the default
MODELS = os.getenv("MODELS", "qwen3.8-27b,glm-5.3,kimi-k3,gpt-oss-120b").split(",")
MCP_URL = os.getenv("MCP_URL", "http://localhost:8000/mcp")
UNIPROT_API = "https://rest.uniprot.org/uniprotkb"
HERE = Path(__file__).parent

# MCP server with UniProt tools
mcp = MCPServer("uniprot", instructions="Query the UniProt protein knowledgebase")


@mcp.tool()
async def search_proteins(query: str, size: int = 5) -> list[dict[str, Any]]:
    """Search UniProtKB entries, e.g. `insulin AND organism_id:9606`, returns accession, name, genes, organism"""
    params = {
        "query": query,
        "size": size,
        "fields": "accession,protein_name,gene_names,organism_name,length",
    }
    async with httpx2.AsyncClient() as client:
        res = await client.get(f"{UNIPROT_API}/search", params=params)
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
    async with httpx2.AsyncClient() as client:
        res = await client.get(f"{UNIPROT_API}/{accession}.json")
        res.raise_for_status()
    e = res.json()
    return {
        "accession": e["primaryAccession"],
        "name": e.get("proteinDescription", {}).get("recommendedName", {}).get("fullName", {}).get("value"),
        "organism": e.get("organism", {}).get("scientificName"),
        "function": [
            t["value"] for c in e.get("comments", []) if c["commentType"] == "FUNCTION" for t in c.get("texts", [])
        ],
        "sequence": e.get("sequence", {}).get("value"),
    }


# Agent using the MCP server tools over HTTP, the model is set per request
agent = Agent(
    instructions="You are a helpful assistant answering questions about proteins using the UniProt tools.",
    toolsets=[MCPToolset(MCP_URL)],
)


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
    model = (body.get("forwardedProps") or {}).get("model") or MODELS[0]
    if model not in MODELS:
        raise HTTPException(400, f"Unknown model {model}, available: {', '.join(MODELS)}")
    return await AGUIAdapter.dispatch_request(request, agent=agent, model=f"openai-chat:{model}")


@app.get("/models")
async def models() -> list[str]:
    """Models available for `/chat`"""
    return MODELS


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(HERE / "index.html")


# light-chat build from the parent repo (`vp run --filter light-chat build`)
app.mount("/static", StaticFiles(directory=HERE.parent / "packages" / "js" / "dist", check_dir=False), name="static")
# Mounted last at the root: it serves `/mcp` and would otherwise shadow the routes above
app.mount("/", mcp.streamable_http_app(stateless_http=True, json_response=True))
