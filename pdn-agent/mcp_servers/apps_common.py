"""Helpers of the tools showing MCP Apps widgets, shared by the servers.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
Widgets are in `../widgets/`, the local scripts and stylesheets they reference are inlined when served.
"""

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from mcp.server.apps import ResourceCsp
from mcp_types import CallToolResult, TextContent

WIDGETS = Path(__file__).parent / "widgets"
# CDN of the libraries loaded by widgets, to allow in their CSP `resource_domains`
CDN = "https://cdn.jsdelivr.net"
# CSP of the widgets, which load the MCP Apps SDK from the CDN
WIDGET_CSP = ResourceCsp(resource_domains=[CDN])


def text_result(text: str, data: Mapping[str, Any]) -> CallToolResult:
    """Summary for the model, full data for the widget"""
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=dict(data))


def widget_html(name: str) -> str:
    """Widget HTML with the local scripts and stylesheets it references inlined"""
    html = (WIDGETS / name).read_text()
    html = re.sub(
        r'<script src="(\w+\.js)"></script>', lambda m: f"<script>\n{(WIDGETS / m[1]).read_text()}</script>", html
    )
    return re.sub(
        r'<link rel="stylesheet" href="(\w+\.css)" />',
        lambda m: f"<style>\n{(WIDGETS / m[1]).read_text()}</style>",
        html,
    )
