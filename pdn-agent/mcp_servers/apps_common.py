"""Helpers of the tools showing MCP Apps widgets, shared by the servers.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
Widgets are in `widgets/`, bundled with their scripts, styles and npm dependencies in one HTML file each in
`widgets/dist/` by `vp run --filter pdn-agent build`.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from mcp.server.apps import Apps
from mcp_types import CallToolResult, TextContent

WIDGETS = Path(__file__).parent / "widgets" / "dist"
# MCP Apps extension of the server, with the widget tools and resources of every resource: `server.py` imports
# the modules registering them before creating the server, which reads them once
apps = Apps()


def text_result(text: str, data: Mapping[str, Any]) -> CallToolResult:
    """Summary for the model, full data for the widget"""
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=dict(data))


def widget_html(name: str) -> str:
    """Bundled widget HTML, with all its dependencies inlined"""
    path = WIDGETS / name
    if not path.exists():
        raise FileNotFoundError(f"Widget {path} not built, run `vp run --filter pdn-agent build`")
    return path.read_text()
