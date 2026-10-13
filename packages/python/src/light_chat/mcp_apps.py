"""Show the UIs of MCP tools (MCP Apps, MCP-UI) in light-chat, from a Pydantic AI agent served over AG-UI.

The agent only forwards, the chat decides what to render:
- `UIToolset` sends each tool result to the chat in an AG-UI `mcp-apps` activity, with the raw MCP result and the
  tool `_meta`, and hides tools only visible to apps from the model
- `proxied_response` answers the MCP requests of widgets (`forwardedProps.__proxiedMCPRequest`), e.g. reading their
  UI resource or calling a tool, sent to the agent endpoint

Requires the `mcp-apps` extra: `pip install "light-chat[mcp-apps]"`
"""

from typing import Any, Self
from uuid import uuid4

from ag_ui.core import ActivitySnapshotEvent, RunFinishedEvent, RunStartedEvent
from ag_ui.encoder import EventEncoder
from fastapi.responses import StreamingResponse
from pydantic_ai import ModelRetry, RunContext, ToolReturn
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import ToolsetTool

__all__ = ["PROXIED_REQUEST", "UIToolset", "proxied_response"]

# Key of `forwardedProps` with the MCP request of a widget
PROXIED_REQUEST = "__proxiedMCPRequest"


def ui_meta(tool: ToolsetTool[Any]) -> dict[str, Any]:
    return ((tool.tool_def.metadata or {}).get("meta") or {}).get("ui") or {}


class UIToolset(MCPToolset[Any]):
    """MCP server whose raw tool results are sent to the chat, tools only visible to apps are hidden from the model"""

    async def __aenter__(self) -> Self:
        """Connection errors name the server, e.g. a wrong URL"""
        try:
            return await super().__aenter__()
        except Exception as e:
            raise ConnectionError(
                f"Could not connect to the MCP server {self.id!r} {self.client.transport}: {e}"
            ) from e

    async def get_tools(self, ctx: RunContext[Any]) -> dict[str, ToolsetTool[Any]]:
        tools = await super().get_tools(ctx)
        return {name: t for name, t in tools.items() if "model" in ui_meta(t).get("visibility", ["model"])}

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        async with self:
            raw = await self.client.call_tool_mcp(name, tool_args)
        result = raw.model_dump(by_alias=True, exclude_none=True, mode="json")
        text = "\n".join(b["text"] for b in result["content"] if b["type"] == "text")
        if result.get("isError"):
            raise ModelRetry(text or f"Tool {name!r} returned an error")
        meta = (tool.tool_def.metadata or {}).get("meta")
        content = {"serverId": self.id, "tool": {"name": name, "_meta": meta}, "toolInput": tool_args, "result": result}
        activity = ActivitySnapshotEvent(message_id=str(uuid4()), activity_type="mcp-apps", content=content)
        return ToolReturn(
            return_value=text or result.get("structuredContent") or "Shown to the user", metadata=[activity]
        )

    async def mcp_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """MCP request sent by a widget, the chat checks which tools a widget can call"""
        async with self:
            if method == "tools/call":
                result = await self.client.call_tool_mcp(params["name"], params.get("arguments") or {})
            elif method == "resources/read":
                result = await self.client.read_resource_mcp(params["uri"])
            elif method == "tools/list":
                result = await self.client.list_tools_mcp()
            else:
                raise ValueError(f"Method {method!r} can not be proxied")
        return result.model_dump(by_alias=True, exclude_none=True, mode="json")


async def proxied_response(body: dict[str, Any], toolsets: list[UIToolset]) -> StreamingResponse:
    """Answer `forwardedProps.__proxiedMCPRequest` with a run whose `RUN_FINISHED` result is the MCP result"""
    request = body["forwardedProps"][PROXIED_REQUEST]
    try:
        toolset = next((t for t in toolsets if t.id == request.get("serverId")), None)
        if toolset is None:
            raise ValueError(f"Unknown MCP server {request.get('serverId')!r}")
        result = await toolset.mcp_request(request["method"], request.get("params") or {})
    except Exception as e:  # noqa: BLE001 - any failure is returned to the widget
        result = {"error": str(e) or type(e).__name__}
    run = {"thread_id": body.get("threadId", ""), "run_id": body.get("runId", "")}
    encoder = EventEncoder()
    events = [RunStartedEvent(**run), RunFinishedEvent(**run, result=result)]
    return StreamingResponse((encoder.encode(e) for e in events), media_type=encoder.get_content_type())
