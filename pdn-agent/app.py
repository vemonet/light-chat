"""FastAPI app exposing the MCP server of the federated data ecosystem, an AG-UI agent using it, and a chat UI."""

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from ag_ui.core import (
    BaseEvent,
    RunErrorEvent,
    TextMessageContentEvent,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from light_chat import chat_router, setup_logging
from light_chat.mcp_apps import PROXIED_REQUEST, UIToolset, proxied_response, ui_meta
from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, BeforeValidator, Field, SecretStr
from pydantic_ai import Agent, RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIChatModelSettings
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.toolsets import AbstractToolset, CombinedToolset, ToolsetTool
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_settings import BaseSettings, NoDecode

from mcp_servers import mcp
from mcp_servers.provenance import provenance_server, split_provenance
from prompt import SYSTEM_PROMPT

setup_logging()
# No first-run banner of Pydantic AI
os.environ["PYDANTIC_AI_NO_BANNER"] = "1"
# Without a line when the MCP session manager starts, the servers are listed once at startup
logging.getLogger("mcp.server.streamable_http_manager").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# Comma-separated list in an environment variable, e.g. `a,b`, instead of the JSON parsed by default
CommaList = Annotated[
    list[str],
    NoDecode,
    BeforeValidator(lambda v: [i.strip() for i in v.split(",") if i.strip()] if isinstance(v, str) else v),
]


# Reasoning effort levels accepted by `OpenAIChatModelSettings.openai_reasoning_effort`
Effort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]


class Model(BaseModel):
    """Tool calling model, with the reasoning effort levels it supports, lowest first"""

    name: str
    effort: list[Effort] = []
    # Level used when the request has none, the middle one in the UI when unset
    default_effort: Effort | None = Field(None, serialization_alias="defaultEffort")


class McpServer(BaseModel):
    """MCP server used by the agent, with its number of tools, None when it did not answer at startup"""

    id: str
    url: str
    tools: int | None


class Info(BaseModel):
    """Models available for `/chat`, and the MCP servers of the agent"""

    models: list[Model]
    mcp_servers: list[McpServer] = Field(serialization_alias="mcpServers")


def parse_models(value: Any) -> Any:
    """Models from a JSON list (names or objects), or comma-separated names without effort levels"""
    if isinstance(value, str):
        value = json.loads(value) if value.lstrip().startswith("[") else [i for i in value.split(",") if i.strip()]
    return [{"name": m.strip()} if isinstance(m, str) else m for m in value]


class Settings(BaseSettings):
    """Configuration from environment variables, named as the fields in upper case, e.g. `MODELS`"""

    # OpenAI-compatible endpoint, with its tool calling models (the first is the default).
    # Effort levels and defaults from the `reasoning.supported_efforts` of https://openrouter.ai/api/v1/models
    openai_base_url: str = "https://openrouter.ai/api/v1"
    openai_api_key: SecretStr | None = None
    models: Annotated[list[Model], NoDecode, BeforeValidator(parse_models)] = [
        Model(name="deepseek/deepseek-v4.1-flash-1017", effort=["none", "low", "high", "max"], default_effort="low"),
        Model(name="mistralai/mistral-large-4-0", effort=["none", "high"], default_effort="high"),
        Model(
            name="anthropic/claude-haiku-5.5",
            effort=["none", "low", "medium", "high", "xhigh", "max"],
            default_effort="medium",
        ),
        Model(
            name="openai/gpt-6-luna",
            effort=["none", "low", "medium", "high", "xhigh", "max"],
            default_effort="medium",
        ),
    ]
    # Public hostnames of the app behind a reverse proxy (e.g. `pdn.example.org`)
    allowed_hosts: CommaList = []
    # JSONL file where each chat request is appended with its response
    log_file: Path = Path("data/pdn_agent_logs.jsonl")
    # JSONL file where each call to a tool of the local MCP server is appended with its result, from the agent or
    # from MCP clients on `/mcp`
    mcp_log_file: Path = Path("data/mcp_logs.jsonl")
    # Hide the MCP tools from the model until it finds them with the `search_tools` tool, instead of sending them all
    defer_tools: bool = True


settings = Settings()
provider = OpenAIProvider(
    base_url=settings.openai_base_url,
    api_key=settings.openai_api_key.get_secret_value() if settings.openai_api_key else None,
)
# Public MCP servers, used as is
REMOTE_MCP_SERVERS = {
    "expasy": "https://chat.expasy.org/mcp/",
    "string": "https://mcp.string-db.org/",
    "brc-analytics": "https://brc-analytics.org/api/v1/mcp/",
    # "excalidraw": "https://mcp.excalidraw.com/mcp",
}


class AppsToolset(UIToolset):
    """MCP server whose raw results are sent to the chat only for the tools showing a UI (MCP Apps)"""

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        result = await super().call_tool(name, tool_args, ctx, tool)
        return result if ui_meta(tool).get("resourceUri") else result.return_value


# MCP server of this app, called in-process
local_toolset = AppsToolset(mcp, id=mcp.name)
remote_toolsets = [AppsToolset(url, id=id) for id, url in REMOTE_MCP_SERVERS.items()]
# Remote servers connected at startup, their sessions kept open for the app lifetime so runs do not reconnect
connected_remote: list[MCPToolset] = []
# Toolsets answering the MCP requests of widgets, with the server of the provenance graph
ui_toolsets = [local_toolset, *remote_toolsets, UIToolset(provenance_server, id="provenance")]
# MCP server ID of each tool, for the provenance graph (those of remote servers are read when they connect). Local
# tools get the resource of their module instead, e.g. `ncbi` for `mcp_servers.ncbi.apps` (the SDK has no public access
# to the functions of the tools)
tool_servers = {
    t.name: t.fn.__module__.split(".")[1].removesuffix("_apps").replace("_", "-")
    for t in mcp._tool_manager.list_tools()
}
# Instructions of the MCP servers by ID, added to the system prompt (those of remote servers are read at startup)
server_instructions = {mcp.name: mcp.instructions} if mcp.instructions else {}
# Number of tools of each MCP server by ID, read at startup, None for the remote ones not answering then
server_tools: dict[str, int | None] = {}


# Toolsets of the agent: the remote ones combined from the list filled at startup, read by each run. Their tools are
# marked for deferred loading (tool search) if enabled
toolsets: list[AbstractToolset[Any]] = [local_toolset, CombinedToolset(connected_remote)]
if settings.defer_tools:
    toolsets = [ts.defer_loading() for ts in toolsets]
# Failed tool calls are sent back to the model a few times, e.g. to fix an invalid query
agent = Agent(toolsets=toolsets, deps_type=str, retries={"tools": 3})


@agent.instructions
def instructions(ctx: RunContext[str]) -> str:
    """One system prompt (some models reject several), with the instructions of the MCP servers, and the context sent
    by the frontend (AG-UI `context`), e.g. the state of a widget edited by the user"""
    servers = "\n\n".join(f"## {id} MCP server\n\n{text}" for id, text in server_instructions.items())
    prompt = f"{SYSTEM_PROMPT}\n\n# Instructions of the MCP servers\n\n{servers}"
    return f"{prompt}\n\n{ctx.deps}" if ctx.deps else prompt


async def connect_remote(stack: AsyncExitStack, ts: MCPToolset) -> int | None:
    """Open the session of a remote MCP server until the stack closes, keeping its tools and instructions. Returns its
    number of tools, or None and a warning if it is unavailable"""
    server_id = ts.id or ts.label
    try:
        async with asyncio.timeout(10):
            await stack.enter_async_context(ts)
            # Cached by the toolset while its session is open
            tools = await ts.list_tools()
    except Exception as e:  # noqa: BLE001 - an unavailable server only costs its tools
        logger.warning(f"MCP server {server_id} unavailable: {e!r}")
        return None
    tool_servers.update({t.name: server_id for t in tools})
    if ts.instructions:
        server_instructions[server_id] = ts.instructions
    connected_remote.append(ts)
    return len(tools)


def log_servers(kind: str, tools: dict[str, int]) -> None:
    """One line listing MCP servers with their number of tools, e.g. `pdn (12) · mygene (8)`"""
    servers = " · ".join(f"{id} ({n})" for id, n in tools.items())
    logger.info(f"{len(tools)} {kind} MCP servers, {sum(tools.values())} tools: {servers}")


# The session manager of the MCP server, and the sessions of the remote servers, run for the whole app lifetime
@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with AsyncExitStack() as stack, mcp.session_manager.run():
        # One after the other: the MCP client must be closed by the task that opened it
        remote_tools = {ts.id or ts.label: await connect_remote(stack, ts) for ts in remote_toolsets}
        local_tools = {mcp.name: len(await mcp.list_tools())}
        server_tools.update(local_tools | remote_tools)
        log_servers("local", local_tools)
        log_servers("remote", {id: n for id, n in remote_tools.items() if n is not None})
        yield


app = FastAPI(title="Pathogen Data Network agent", lifespan=lifespan)


def last_user_text(body: dict) -> str | None:
    """Text of the last user message of an AG-UI run input, the question of the provenance graph"""
    message = next((m for m in reversed(body.get("messages") or []) if m.get("role") == "user"), None)
    content = (message or {}).get("content")
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    return content


def append_log(path: Path, entry: dict[str, Any]) -> None:
    """Append an entry as one line of a JSONL file, a warning if it cannot be written"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except OSError as e:
        logger.warning(f"Could not write the log to {path}: {e!r}")


async def log_tool_calls(ctx: ServerRequestContext[Any, Any], call_next: CallNext) -> HandlerResult:
    """MCP server middleware appending each tool call, with its args and result, to the MCP log file"""
    if ctx.method != "tools/call":
        return await call_next(ctx)
    start = time.monotonic()
    timestamp = datetime.now(UTC).isoformat()
    result: HandlerResult = None
    error: str | None = None
    try:
        result = await call_next(ctx)
        return result
    except Exception as e:
        # Protocol errors (unknown tool, invalid params) are raised, failed tools return a result with `isError`
        error = repr(e)
        raise
    finally:
        params = ctx.params or {}
        client = ctx.session.client_params.client_info if ctx.session.client_params else None
        entry = {
            "timestamp": timestamp,
            "duration": round(time.monotonic() - start, 2),
            "tool": params.get("name"),
            "args": params.get("arguments"),
            "result": result.model_dump(mode="json", by_alias=True, exclude_none=True)
            if isinstance(result, BaseModel)
            else result,
            "error": error,
            "client": client.model_dump(mode="json", exclude_none=True) if client else None,
        }
        append_log(settings.mcp_log_file, entry)


mcp.middleware.append(log_tool_calls)


async def log_run(events: AsyncIterator[BaseEvent], model: str, question: str | None) -> AsyncIterator[BaseEvent]:
    """Pass the events through, and append the question, answer, provenance and tool calls of the run to the log
    file once it ends, also when it fails or the client disconnects"""
    start = time.monotonic()
    answer, provenance, error = "", "", None
    tool_calls: dict[str, dict[str, Any]] = {}
    try:
        async for e in events:
            if isinstance(e, TextMessageContentEvent):
                # The provenance is streamed in a sub-agent message
                if e.subagent_run_id:
                    provenance += e.delta
                else:
                    answer += e.delta
            elif isinstance(e, ToolCallStartEvent):
                tool_calls[e.tool_call_id] = {"name": e.tool_call_name, "args": "", "result": None}
            elif isinstance(e, ToolCallArgsEvent) and e.tool_call_id in tool_calls:
                tool_calls[e.tool_call_id]["args"] += e.delta
            elif isinstance(e, ToolCallResultEvent) and e.tool_call_id in tool_calls:
                tool_calls[e.tool_call_id]["result"] = e.content
            elif isinstance(e, RunErrorEvent):
                error = e.message
            yield e
    finally:
        entry = {
            "timestamp": datetime.now(UTC).isoformat(),
            "duration": round(time.monotonic() - start, 2),
            "model": model,
            "question": question,
            "answer": answer,
            "provenance": provenance,
            "tool_calls": list(tool_calls.values()),
            "error": error,
        }
        append_log(settings.log_file, entry)


@app.post("/chat")
async def chat(request: Request) -> Response:
    """AG-UI endpoint streaming the agent response, with the model and effort picked in `forwardedProps`.
    The provenance written after the answer, and the graph of the tool calls, are sent as a sub-agent message"""
    body = await request.json()  # cached, the adapter reads the body again
    forwarded = body.get("forwardedProps") or {}
    # MCP request from a widget, e.g. reading its UI resource or calling a tool of its server
    if PROXIED_REQUEST in forwarded:
        return await proxied_response(body, ui_toolsets)
    model = forwarded.get("model") or settings.models[0].name
    config = next((m for m in settings.models if m.name == model), None)
    if config is None:
        raise HTTPException(400, f"Unknown model {model}, available: {', '.join(m.name for m in settings.models)}")
    # Reasoning effort among the levels of the model, none sent when it has no levels
    effort = forwarded.get("effort") or config.default_effort
    # The level of the model matching the request, typed as an effort level
    level = next((e for e in config.effort if e == effort), None)
    if effort and level is None:
        raise HTTPException(400, f"Unknown effort {effort} for {model}, available: {', '.join(config.effort)}")
    model_settings = OpenAIChatModelSettings(openai_reasoning_effort=level) if level else None
    context = "\n\n".join(f"{c['description']}:\n{c['value']}" for c in body.get("context") or [])
    adapter = await AGUIAdapter[str, str].from_request(request, agent=agent)
    chat_model = OpenAIChatModel(model, provider=provider, settings=model_settings)
    events = adapter.run_stream(model=chat_model, deps=context)
    question = last_user_text(body)
    events = log_run(split_provenance(events, tool_servers, question, model), model, question)
    return adapter.streaming_response(events)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(Path(__file__).parent / "static" / "favicon.png", media_type="image/png")


@app.get("/info")
async def info() -> Info:
    """Models available for `/chat` with their effort levels, and the MCP servers of the agent with their number of
    tools, as read at startup (no request to the remote servers, also used as healthcheck)"""
    # Relative like `chat`, resolved by the UI against the URL of `/info`
    urls = {mcp.name: "mcp", **REMOTE_MCP_SERVERS}
    servers = [McpServer(id=id, url=urls[id], tools=n) for id, n in server_tools.items()]
    return Info(models=settings.models, mcp_servers=servers)


# Chat UI at `/`, the model and effort picked in the settings are sent in `forwardedProps`
app.include_router(
    chat_router(
        path="/",
        # Relative to the page, so it works behind a reverse proxy serving the app under a prefix
        url="chat",
        title="Pathogen Data Network agent",
        favicon="favicon.ico",
        settings={"models": [m.model_dump(by_alias=True, exclude_none=True) for m in settings.models]},
        # MCP servers with their number of tools, listed from a button in the toolbar
        mcpServers="info",
        themeSwitch=True,
        welcome=(
            "## Ask about pathogens, genes, proteins and datasets\nThe agent federates the Pathogen Data Network, "
            "NCBI, UniProt, MyGene, MyVariant, GEO, PubMed, the NIAID Data Ecosystem, BRC Analytics, STRING and "
            "ExPASy, and shows how it got each answer."
        ),
        placeholder="Ask a question",
        # Short questions, together they call every MCP server and most widgets
        examples=[
            "How common was the SARS-CoV-2 mutation S:L455S in Switzerland in 2024, and why did it matter?",
            "Where do mpox clade Ib sequences come from, and which mutations do they carry?",
            "Which antibiotic resistance genes are found in Klebsiella pneumoniae, E. coli and Salmonella isolates?",
            "Find public datasets on carbapenem-resistant bacteria",
            "Which genome assemblies and analysis workflows are available for Brucella abortus?",
            "Find gene expression studies of E. coli exposed to ciprofloxacin",
            "What does the CFTR gene do, and what is its most common cystic fibrosis variant?",
            "Show the 3D structure of hemoglobin beta and where the sickle cell mutation is",
            "Which proteins interact with TP53, and in which pathways?",
            "Compare insulin across mammals and show the human sequence",
        ],
    )
)
# The MCP SDK only accepts localhost Host and Origin headers (DNS rebinding protection), and answers
# "Invalid Host header" to requests forwarded by a reverse proxy: the public hostnames are added to the allowed ones
local_hosts = ["127.0.0.1", "localhost", "[::1]"]
transport_security = TransportSecuritySettings(
    allowed_hosts=[f"{h}:*" for h in local_hosts] + settings.allowed_hosts,
    allowed_origins=[f"http://{h}:*" for h in local_hosts]
    + [f"{scheme}://{h}" for h in settings.allowed_hosts for scheme in ("https", "http")],
)
# MCP server of the app at `/mcp`, its route added to the app instead of mounting it under a prefix
mcp_app = mcp.streamable_http_app(stateless_http=True, json_response=True, transport_security=transport_security)
app.router.routes.extend(mcp_app.routes)
