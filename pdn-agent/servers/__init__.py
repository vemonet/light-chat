"""MCP servers of the agent, by the path they are served under, e.g. `/pdn/mcp`"""

from mcp.server.mcpserver import MCPServer

from . import brc_analytics, geo, mygene, myvariant, pdn, pubmed, uniprot
from .ncbi import server as ncbi
from .nde import server as nde

MCP_SERVERS: dict[str, MCPServer] = {
    "pdn": pdn.mcp,
    "uniprot": uniprot.mcp,
    "mygene": mygene.mcp,
    "myvariant": myvariant.mcp,
    "ncbi": ncbi.server,
    "pubmed": pubmed.mcp,
    "nde": nde.mcp,
    "geo": geo.mcp,
    "brc-analytics": brc_analytics.mcp,
}
