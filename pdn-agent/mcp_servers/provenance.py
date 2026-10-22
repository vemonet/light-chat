"""Provenance of an answer shown as a collapsed sub-agent after it, from the same LLM response.

The system prompt asks the model to write `MARKER` on its own line between the answer and its provenance (resources
chosen, tool calls, derivations, caveats, sources). The text after the marker is sent as the text message of a
`provenance` AG-UI sub-agent, that the chat shows collapsed below the answer, rendered as markdown.

The tool calls of the run are also shown in this sub-agent as a graph (MCP App widget), built from the AG-UI events:
arguments, counts and URLs of each call, without asking the model.
"""

import json
import re
from collections.abc import AsyncIterator, Mapping
from typing import Any, TypedDict
from uuid import uuid4

from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    RunFinishedEvent,
    SubagentFinishedEvent,
    SubagentStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from mcp.server.apps import Apps
from mcp.server.mcpserver import MCPServer

from .apps_common import WIDGET_CSP, widget_html

MARKER = "<!--PROVENANCE-->"
GRAPH_URI = "ui://provenance/graph.html"
# Suffix of the retry prompts sent to the model when a tool call failed
RETRY_SUFFIX = "Fix the errors and try again."
URL_RE = re.compile(r"https?://[^\s\"'<>`)\]]+")

# MCP server only serving the graph widget to the chat, its data comes from the run events
apps = Apps()
apps.add_html_resource(GRAPH_URI, widget_html("provenance-graph.html"), title="Provenance graph", csp=WIDGET_CSP)
provenance_server = MCPServer("provenance", instructions="Graph of the tool calls of an answer", extensions=[apps])


class Call(TypedDict):
    id: str
    name: str
    server: str | None
    step: int
    """Model response that made the call, calls of one step run in parallel"""
    args: Any
    status: str
    """`running`, `ok` or `error` (the model was asked to retry)"""
    counts: dict[str, float]
    """Numbers and lengths of non-empty lists at the top level of a JSON result"""
    urls: list[str]
    chars: int
    preview: str


class Graph(TypedDict):
    question: str | None
    model: str
    calls: list[Call]


def summarize(call: Call, content: str) -> None:
    """Counts, URLs and preview of a tool result"""
    try:
        data = json.loads(content)
    except ValueError:
        data = None
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                call["counts"][key] = value
            elif isinstance(value, list) and value:
                call["counts"][key] = len(value)
    elif isinstance(data, list):
        call["counts"]["items"] = len(data)
    call["counts"] = dict(list(call["counts"].items())[:8])
    call["urls"] = list(dict.fromkeys(m.rstrip(".,;") for m in URL_RE.findall(content)))[:10]
    call["status"] = "error" if content.rstrip().endswith(RETRY_SUFFIX) else "ok"
    call["chars"] = len(content)
    call["preview"] = content[:800]


def held_back(text: str) -> int:
    """Index of the tail of `text` that could be the start of a marker split across deltas"""
    start = max(0, len(text) - len(MARKER) + 1)
    return next((i for i in range(start, len(text)) if MARKER.startswith(text[i:])), len(text))


async def split_provenance(
    events: AsyncIterator[BaseEvent], tool_servers: Mapping[str, str], question: str | None, model: str
) -> AsyncIterator[BaseEvent]:
    """Turn the text after `MARKER` in each text message into the text message of a provenance sub-agent, and add the
    graph of the tool calls to it at the end of the run. `tool_servers` gives the MCP server ID of each tool"""
    buffer = ""
    # Sub-agent run and its message receiving the text, once the marker is found in the current text message
    run_id: str | None = None
    message_id = ""
    # Last provenance sub-agent of the run, receiving the graph
    provenance_id: str | None = None
    calls: dict[str, Call] = {}
    step, in_step = 0, False
    async for e in events:
        if isinstance(e, TextMessageStartEvent):
            buffer, run_id = "", None
            yield e
        elif isinstance(e, TextMessageContentEvent) and run_id:
            yield TextMessageContentEvent(message_id=message_id, delta=e.delta, subagent_run_id=run_id)
        elif isinstance(e, TextMessageContentEvent):
            buffer += e.delta
            if MARKER in buffer:
                # End the answer, start the provenance
                answer, _, provenance = buffer.partition(MARKER)
                buffer, run_id, message_id = "", str(uuid4()), str(uuid4())
                provenance_id = run_id
                if answer.strip():
                    yield TextMessageContentEvent(message_id=e.message_id, delta=answer.rstrip())
                yield TextMessageEndEvent(message_id=e.message_id)
                yield SubagentStartedEvent(subagent_run_id=run_id, name="provenance")
                yield TextMessageStartEvent(message_id=message_id, subagent_run_id=run_id)
                if provenance.strip():
                    yield TextMessageContentEvent(
                        message_id=message_id, delta=provenance.lstrip(), subagent_run_id=run_id
                    )
                continue
            # Stream the text, except a tail that could be the start of the marker
            cut = held_back(buffer)
            if cut:
                yield TextMessageContentEvent(message_id=e.message_id, delta=buffer[:cut])
                buffer = buffer[cut:]
        elif isinstance(e, TextMessageEndEvent) and run_id:
            yield TextMessageEndEvent(message_id=message_id, subagent_run_id=run_id)
            yield SubagentFinishedEvent(subagent_run_id=run_id)
            run_id = None
        elif isinstance(e, TextMessageEndEvent):
            if buffer:
                yield TextMessageContentEvent(message_id=e.message_id, delta=buffer)
                buffer = ""
            yield e
        elif isinstance(e, RunFinishedEvent) and calls:
            # Graph of the calls in the provenance sub-agent, a new one if the model wrote no provenance
            if not provenance_id:
                provenance_id = str(uuid4())
                yield SubagentStartedEvent(subagent_run_id=provenance_id, name="provenance")
                yield SubagentFinishedEvent(subagent_run_id=provenance_id)
            graph = Graph(question=question, model=model, calls=list(calls.values()))
            for call in graph["calls"]:
                if isinstance(call["args"], str):
                    try:
                        call["args"] = json.loads(call["args"] or "{}")
                    except ValueError:
                        pass
            content = {
                "serverId": "provenance",
                "resourceUri": GRAPH_URI,
                "toolInput": {},
                "result": {
                    "content": [{"type": "text", "text": f"Graph of the {len(calls)} tool calls of the answer"}],
                    "structuredContent": graph,
                },
            }
            yield ActivitySnapshotEvent(
                message_id=str(uuid4()), activity_type="mcp-apps", content=content, subagent_run_id=provenance_id
            )
            yield e
        else:
            # Tool calls of the run, a call started after results opens a new step
            if isinstance(e, ToolCallStartEvent):
                if not in_step:
                    step, in_step = step + 1, True
                name = e.tool_call_name
                server = tool_servers.get(name)
                # The chat shows the MCP server in front of the tool name
                if server:
                    e.metadata = {**(e.metadata or {}), "server": server}
                calls[e.tool_call_id] = Call(
                    id=e.tool_call_id,
                    name=name,
                    server=server,
                    step=step,
                    args="",
                    status="running",
                    counts={},
                    urls=[],
                    chars=0,
                    preview="",
                )
            elif isinstance(e, ToolCallArgsEvent) and e.tool_call_id in calls:
                calls[e.tool_call_id]["args"] += e.delta
            elif isinstance(e, ToolCallResultEvent) and e.tool_call_id in calls:
                in_step = False
                summarize(calls[e.tool_call_id], e.content)
            yield e
