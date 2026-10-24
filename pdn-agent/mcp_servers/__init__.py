"""Pathogen Data Network MCP server of the agent, served under `/mcp`"""

# Modules of the tools of each resource, registered on the server when imported
from . import brc_analytics, geo, mygene, myvariant, pdn, pubmed  # noqa: F401
from .ncbi import server as ncbi  # noqa: F401
from .nde import server as nde  # noqa: F401
from .server import mcp

__all__ = ["mcp"]
