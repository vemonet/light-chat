"""FastAPI app exposing the MCP servers of the federated data ecosystem, an AG-UI agent using them, and a chat UI."""

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from ag_ui.core import (
    BaseEvent,
    RunErrorEvent,
    TextMessageContentEvent,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from fastapi import FastAPI, HTTPException, Request, Response
from light_chat import chat_router, setup_logging
from light_chat.mcp_apps import PROXIED_REQUEST, UIToolset, proxied_response, ui_meta
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, BeforeValidator, Field, SecretStr
from pydantic_ai import Agent, RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIChatModelSettings
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.toolsets import AbstractToolset, ToolsetTool
from pydantic_ai.ui.ag_ui import AGUIAdapter
from pydantic_settings import BaseSettings, NoDecode

from mcp_servers import MCP_SERVERS
from mcp_servers.provenance import provenance_server, split_provenance
from prompt import SYSTEM_PROMPT

setup_logging()
# No first-run banner of Pydantic AI
os.environ["PYDANTIC_AI_NO_BANNER"] = "1"
# Without a line per MCP server session manager started, the servers are listed once at startup
logging.getLogger("mcp.server.streamable_http_manager").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# Comma-separated list in an environment variable, e.g. `a,b`, instead of the JSON parsed by default
CommaList = Annotated[
    list[str],
    NoDecode,
    BeforeValidator(lambda v: [i.strip() for i in v.split(",") if i.strip()] if isinstance(v, str) else v),
]


class Model(BaseModel):
    """Tool calling model, with the reasoning effort levels it supports, lowest first"""

    name: str
    effort: list[str] = []
    # Level used when the request has none, the middle one in the UI when unset
    default_effort: str | None = Field(None, serialization_alias="defaultEffort")


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
    # Hide the MCP tools from the model until it finds them with the `search_tools` tool, instead of sending them all
    defer_tools: bool = True


settings = Settings()
provider = OpenAIProvider(
    base_url=settings.openai_base_url,
    api_key=settings.openai_api_key.get_secret_value() if settings.openai_api_key else None,
)
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


# MCP servers of this app, called in-process
local_toolsets = [AppsToolset(server, id=path) for path, server in MCP_SERVERS.items()]
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


def agent_toolsets(toolsets: Sequence[MCPToolset]) -> list[AbstractToolset[Any]]:
    """Toolsets given to the agent, with their tools marked for deferred loading (tool search) if enabled"""
    return [ts.defer_loading() for ts in toolsets] if settings.defer_tools else list(toolsets)


# Failed tool calls are sent back to the model a few times, e.g. to fix an invalid query
agent = Agent(toolsets=agent_toolsets(local_toolsets), deps_type=str, retries={"tools": 3})


@agent.instructions
def instructions(ctx: RunContext[str]) -> str:
    """One system prompt (some models reject several), with the instructions of the MCP servers, and the context sent
    by the frontend (AG-UI `context`), e.g. the state of a widget edited by the user"""
    servers = "\n\n".join(f"## {id} MCP server\n\n{text}" for id, text in server_instructions.items())
    prompt = f"{SYSTEM_PROMPT}\n\n# Instructions of the MCP servers\n\n{servers}"
    return f"{prompt}\n\n{ctx.deps}" if ctx.deps else prompt


async def check_remote(ts: MCPToolset) -> int | None:
    """Number of tools of a remote MCP server, keeping its instructions, or None and a warning if it is unavailable"""
    server_id = ts.id or ts.label
    try:
        async with asyncio.timeout(10), ts:
            tools = await ts.list_tools()
            tool_servers.update({t.name: server_id for t in tools})
            if ts.instructions:
                server_instructions[server_id] = ts.instructions
    except Exception as e:  # noqa: BLE001 - an unavailable server only costs its tools
        logger.warning(f"MCP server {server_id} unavailable: {e!r}")
        failed_checks[server_id] = time.monotonic()
        return None
    failed_checks.pop(server_id, None)
    return len(tools)


async def available_remote_toolsets() -> list[MCPToolset]:
    """Remote servers that answered their last check, the ones that failed it a while ago are checked again"""
    now = time.monotonic()
    retry = [ts for ts in remote_toolsets if ts.id in failed_checks and now - failed_checks[ts.id] > RETRY_SECONDS]
    await asyncio.gather(*(check_remote(ts) for ts in retry))
    return [ts for ts in remote_toolsets if ts.id not in failed_checks]


def log_servers(kind: str, tools: dict[str, int]) -> None:
    """One line listing MCP servers with their number of tools, e.g. `pdn (12) · mygene (8)`"""
    servers = " · ".join(f"{id} ({n})" for id, n in tools.items())
    logger.info(f"{len(tools)} {kind} MCP servers, {sum(tools.values())} tools: {servers}")


# The session managers of the MCP servers must run for the whole app lifetime
@asynccontextmanager
async def lifespan(_app: FastAPI):
    remote_tools = await asyncio.gather(*(check_remote(ts) for ts in remote_toolsets))
    local_tools: dict[str, int] = {}
    for path, server in MCP_SERVERS.items():
        tools = await server.list_tools()
        tool_servers.update({t.name: path for t in tools})
        local_tools[path] = len(tools)
    async with AsyncExitStack() as stack:
        for server in MCP_SERVERS.values():
            await stack.enter_async_context(server.session_manager.run())
        log_servers("local", local_tools)
        log_servers("remote", {ts.id or ts.label: n for ts, n in zip(remote_toolsets, remote_tools) if n is not None})
        yield


app = FastAPI(title="Federated data ecosystem agent", lifespan=lifespan)


def last_user_text(body: dict) -> str | None:
    """Text of the last user message of an AG-UI run input, the question of the provenance graph"""
    message = next((m for m in reversed(body.get("messages") or []) if m.get("role") == "user"), None)
    content = (message or {}).get("content")
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    return content


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
        try:
            settings.log_file.parent.mkdir(parents=True, exist_ok=True)
            with settings.log_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as e:
            logger.warning(f"Could not write the request log to {settings.log_file}: {e!r}")


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
    if effort and effort not in config.effort:
        raise HTTPException(400, f"Unknown effort {effort} for {model}, available: {', '.join(config.effort)}")
    model_settings = OpenAIChatModelSettings(openai_reasoning_effort=effort) if effort else None
    context = "\n\n".join(f"{c['description']}:\n{c['value']}" for c in body.get("context") or [])
    adapter = await AGUIAdapter[str, str].from_request(request, agent=agent)
    toolsets = agent_toolsets(await available_remote_toolsets())
    chat_model = OpenAIChatModel(model, provider=provider, settings=model_settings)
    events = adapter.run_stream(model=chat_model, deps=context, toolsets=toolsets)
    question = last_user_text(body)
    events = log_run(split_provenance(events, tool_servers, question, model), model, question)
    return adapter.streaming_response(events)


@app.get("/models")
async def models() -> list[Model]:
    """Models available for `/chat`, with their effort levels"""
    return settings.models


# Chat UI at `/`, the model and effort picked in the settings are sent in `forwardedProps`
app.include_router(
    chat_router(
        path="/",
        # Relative to the page, so it works behind a reverse proxy serving the app under a prefix
        url="chat",
        title="Pathogen Data Network agent",
        settings={"models": [m.model_dump(by_alias=True, exclude_none=True) for m in settings.models]},
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
            "Draw a diagram of the reaction catalyzed by hexokinase",
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
# MCP servers of the app, each under its own path, e.g. `/pdn/mcp`
for path, server in MCP_SERVERS.items():
    app.mount(
        f"/{path}",
        server.streamable_http_app(stateless_http=True, json_response=True, transport_security=transport_security),
    )
