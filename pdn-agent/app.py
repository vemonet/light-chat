"""FastAPI app exposing the MCP servers of the federated data ecosystem, an AG-UI agent using them, and a chat UI."""

import asyncio
import logging
import os
import time
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from light_chat import chat_router, setup_logging
from light_chat.mcp_apps import PROXIED_REQUEST, UIToolset, proxied_response, ui_meta
from mcp.server.transport_security import TransportSecuritySettings
from pydantic_ai import Agent, RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import ToolsetTool
from pydantic_ai.ui.ag_ui import AGUIAdapter

from prompt import SYSTEM_PROMPT
from provenance import provenance_server, split_provenance
from servers import MCP_SERVERS

# Logs of all libraries in the uvicorn style, without a line per HTTP request
setup_logging()
logger = logging.getLogger(__name__)

# OpenAI-compatible endpoint, read by the OpenAI provider, with its tool calling models (the first is the default)
os.environ.setdefault("OPENAI_BASE_URL", "https://llm.ai.egi.eu/v1")
MODELS = os.getenv("MODELS", "qwen3.8-27b,glm-5.3,kimi-k3,gpt-oss-120b").split(",")
# MCP servers of this app used by the agent: called in-process, unless a base URL is set, e.g. http://localhost:8083
MCP_BASE_URL = os.getenv("MCP_BASE_URL")
# Public MCP servers, used as is
REMOTE_MCP_SERVERS = {
    "string-public": "https://mcp.string-db.org/",
    "expasy": "https://chat.expasy.org/mcp/",
    # The trailing slash is required, without it the server redirects to plain http, which the MCP client refuses
    "brc-analytics-public": "https://brc-analytics.org/api/v1/mcp/",
    "excalidraw": "https://mcp.excalidraw.com/mcp",
}


class AppsToolset(UIToolset):
    """MCP server whose raw results are sent to the chat only for the tools showing a UI (MCP Apps)"""

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        result = await super().call_tool(name, tool_args, ctx, tool)
        return result if ui_meta(tool).get("resourceUri") else result.return_value


local_toolsets = [AppsToolset(f"{MCP_BASE_URL}/{p}/mcp" if MCP_BASE_URL else s, id=p) for p, s in MCP_SERVERS.items()]
remote_toolsets = [AppsToolset(url, id=id) for id, url in REMOTE_MCP_SERVERS.items()]
# Time of the last failed check of remote servers by ID: they are skipped instead of failing every run, and checked
# again after a while
failed_checks: dict[str, float] = {}
RETRY_SECONDS = 300
# Toolsets answering the MCP requests of widgets, with the server of the provenance graph
ui_toolsets = [*local_toolsets, *remote_toolsets, UIToolset(provenance_server, id="provenance")]
# MCP server ID of each tool, for the provenance graph (those of remote servers are read when checked)
tool_servers: dict[str, str] = {}
# Instructions of the MCP servers by ID, added to the system prompt (those of remote servers are read at startup)
server_instructions = {p: s.instructions for p, s in MCP_SERVERS.items() if s.instructions}

# Failed tool calls are sent back to the model a few times, e.g. to fix an invalid query
agent = Agent(toolsets=local_toolsets, deps_type=str, retries={"tools": 3})


@agent.instructions
def instructions(ctx: RunContext[str]) -> str:
    """One system prompt (some models reject several), with the instructions of the MCP servers, and the context sent
    by the frontend (AG-UI `context`), e.g. the state of a widget edited by the user"""
    servers = "\n\n".join(f"## {id} MCP server\n\n{text}" for id, text in server_instructions.items())
    prompt = f"{SYSTEM_PROMPT}\n\n# Instructions of the MCP servers\n\n{servers}"
    return f"{prompt}\n\n{ctx.deps}" if ctx.deps else prompt


async def check_remote(ts: MCPToolset) -> bool:
    """Log the number of tools of a remote MCP server, or why it is unavailable, and keep its instructions"""
    try:
        async with asyncio.timeout(10), ts:
            tools = await ts.list_tools()
            tool_servers.update({t.name: ts.id for t in tools})
            if ts.instructions:
                server_instructions[ts.id] = ts.instructions
    except Exception as e:  # noqa: BLE001 - an unavailable server only costs its tools
        logger.warning(f"MCP server {ts.id} unavailable: {e!r}")
        failed_checks[ts.id] = time.monotonic()
        return False
    logger.info(f"MCP server {ts.id}: {len(tools)} tools")
    failed_checks.pop(ts.id, None)
    return True


async def available_remote_toolsets() -> list[MCPToolset]:
    """Remote servers that answered their last check, the ones that failed it a while ago are checked again"""
    now = time.monotonic()
    retry = [ts for ts in remote_toolsets if ts.id in failed_checks and now - failed_checks[ts.id] > RETRY_SECONDS]
    await asyncio.gather(*(check_remote(ts) for ts in retry))
    return [ts for ts in remote_toolsets if ts.id not in failed_checks]


# The session managers of the MCP servers must run for the whole app lifetime
@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.gather(*(check_remote(ts) for ts in remote_toolsets))
    for path, server in MCP_SERVERS.items():
        tool_servers.update({t.name: path for t in await server.list_tools()})
    async with AsyncExitStack() as stack:
        for server in MCP_SERVERS.values():
            await stack.enter_async_context(server.session_manager.run())
        yield


app = FastAPI(title="Federated data ecosystem agent", lifespan=lifespan)


def last_user_text(body: dict) -> str | None:
    """Text of the last user message of an AG-UI run input, the question of the provenance graph"""
    message = next((m for m in reversed(body.get("messages") or []) if m.get("role") == "user"), None)
    content = (message or {}).get("content")
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    return content


@app.post("/chat")
async def chat(request: Request) -> Response:
    """AG-UI endpoint streaming the agent response, with the model picked in `forwardedProps.model`.
    The provenance written after the answer, and the graph of the tool calls, are sent as a sub-agent message"""
    body = await request.json()  # cached, the adapter reads the body again
    forwarded = body.get("forwardedProps") or {}
    # MCP request from a widget, e.g. reading its UI resource or calling a tool of its server
    if PROXIED_REQUEST in forwarded:
        return await proxied_response(body, ui_toolsets)
    model = forwarded.get("model") or MODELS[0]
    if model not in MODELS:
        raise HTTPException(400, f"Unknown model {model}, available: {', '.join(MODELS)}")
    context = "\n\n".join(f"{c['description']}:\n{c['value']}" for c in body.get("context") or [])
    adapter = await AGUIAdapter.from_request(request, agent=agent)
    toolsets = await available_remote_toolsets()
    events = adapter.run_stream(model=f"openai-chat:{model}", deps=context, toolsets=toolsets)
    return adapter.streaming_response(split_provenance(events, tool_servers, last_user_text(body), model))


@app.get("/models")
async def models() -> list[str]:
    """Models available for `/chat`"""
    return MODELS


# Chat UI at `/`, the model picked in the settings is sent in `forwardedProps.model`
app.include_router(
    chat_router(
        path="/",
        # Relative to the page, so it works behind a reverse proxy serving the app under a prefix
        url="chat",
        title="Pathogen Data Network agent",
        settings={"models": MODELS},
        themeSwitch=True,
        welcome=(
            "## Ask about pathogens, genes, proteins and datasets\nThe agent federates the Pathogen Data Network, "
            "NCBI, UniProt, MyGene, MyVariant, GEO, PubMed, the NIAID Data Ecosystem, BRC Analytics, STRING and "
            "ExPASy, and shows how it got each answer."
        ),
        placeholder="Ask a question",
        # Together they call every MCP server, most of their tools, and the widgets
        examples=[
            (
                "Plot the share of Swiss SARS-CoV-2 sequences carrying S:L455S per month in 2024 in LAPIS, map where "
                "the 2024 sequences come from, and summarize the most relevant PubMed article on this mutation"
            ),
            (
                "Show the mutations of mpox clade Ib sequences in Pathoplexus along the genome, then the metadata and "
                "sequence of the most recent sample from this clade"
            ),
            (
                "How many Klebsiella pneumoniae isolates in NCBI Pathogen Detection carry a KPC carbapenemase gene? "
                "Show them in a table, compare the bla genes of Klebsiella, E. coli and Salmonella in a heatmap, and "
                "list datasets on carbapenem resistance from the NIAID Data Ecosystem"
            ),
            (
                "What is the NCBI taxonomy ID of Brucella abortus, which reference genome assembly does NCBI hold for "
                "it, how many SRA runs does its BioProject have, and which BRC Analytics workflows can run on its "
                "assemblies?"
            ),
            (
                "Find an E. coli ciprofloxacin expression study in GEO, show its samples and processed expression "
                "files, and look up its study in ENA"
            ),
            (
                "Show the gene card of human CFTR with its NCBI Gene summary, and the variant card of its F508del "
                "variant (rs113993960)"
            ),
            (
                "Show the 3D structure of human AKT1 with the E17K mutation highlighted, and its STRING interaction "
                "network with the functional enrichment of its partners"
            ),
            (
                "Compare the functions of the DNA damage response genes TP53, MDM2, CDKN1A, ATM, CHEK2 and BRCA1, then "
                "show the domains, PTMs and pathogenic variants of TP53"
            ),
            "Find the insulin entries of all mammals in UniProt, and get the amino acid sequence of human insulin",
            (
                "Query Rhea through the ExPASy SPARQL endpoint for reactions involving ATP hydrolysis, then draw an "
                "Excalidraw diagram of one of them"
            ),
        ],
    )
)
# MCP servers of the app, each under its own path, e.g. `/pdn/mcp`. Without DNS rebinding protection, enabled by
# default for localhost, which rejects the hosts of a reverse proxy: the servers are public and read-only
no_host_check = TransportSecuritySettings(enable_dns_rebinding_protection=False)
for path, server in MCP_SERVERS.items():
    app.mount(
        f"/{path}",
        server.streamable_http_app(stateless_http=True, json_response=True, transport_security=no_host_check),
    )
