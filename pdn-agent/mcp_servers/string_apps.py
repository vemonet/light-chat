"""STRING tool showing protein interaction networks in an interactive widget (MCP Apps).

The remote STRING MCP server answers in text, this tool calls the STRING REST API to show the network to the user:
the widget gets the full network in `structuredContent`, the model only gets a text summary.
API docs: https://string-db.org/cgi/help?subpage=api
"""

from collections import Counter
from typing import Any, TypedDict

import requests
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult

from .apps_common import apps, text_result, widget_html

STRING_API = "https://string-db.org/api/json"
STRING_URL = "https://string-db.org"
CALLER = "pdn-agent"
# Evidence channels by their field in the API, in the order of the legend
CHANNELS = {
    "escore": "experiments",
    "dscore": "databases",
    "tscore": "textmining",
    "ascore": "coexpression",
    "nscore": "neighborhood",
    "fscore": "fusion",
    "pscore": "cooccurrence",
}
MAX_PROTEINS = 200
MAX_PARTNERS = 100


# Data sent to the widget in `structuredContent`, as read by `widgets/string-network.html`
class Node(TypedDict):
    id: str
    """STRING ID, e.g. 9606.ENSP00000269305"""
    name: str
    annotation: str
    query: bool
    """Asked for, else added as a top partner"""


class Edge(TypedDict):
    source: str
    target: str
    score: float
    scores: dict[str, float]
    """Score of each evidence channel"""
    channel: str
    """Channel with the highest score"""


class NetworkData(TypedDict):
    species: int
    organism: str | None
    minScore: float
    networkType: str
    nodes: list[Node]
    edges: list[Edge]
    missing: list[str]
    """Queries STRING did not find"""
    pValue: float | None
    """PPI enrichment p-value of the queried proteins"""
    expectedEdges: int | None
    url: str


def string_api(endpoint: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """POST to the STRING API (identifiers lists are long), STRING errors become tool errors"""
    try:
        res = requests.post(f"{STRING_API}/{endpoint}", data={**params, "caller_identity": CALLER}, timeout=60)
    except requests.RequestException as e:
        raise ToolError(f"Could not reach STRING ({endpoint}): {e}") from e
    try:
        payload = res.json()
    except ValueError:
        raise ToolError(f"STRING returned non-JSON content (HTTP {res.status_code}): {res.text[:300]}") from None
    if res.status_code >= 400 or (payload and isinstance(payload[0], dict) and "Error" in payload[0]):
        error = payload[0] if isinstance(payload, list) and payload else {}
        raise ToolError(f"STRING error: {error.get('ErrorMessage') or error.get('Error') or res.status_code}")
    return payload


def edge_of(e: dict[str, Any]) -> Edge:
    scores = {name: float(e.get(key) or 0) for key, name in CHANNELS.items()}
    return {
        "source": e["stringId_A"],
        "target": e["stringId_B"],
        "score": float(e["score"]),
        "scores": scores,
        "channel": max(scores, key=lambda c: scores[c]),
    }


@apps.tool(resource_uri="ui://string/network.html")
def show_string_network(
    proteins: list[str],
    species: int = 9606,
    min_score: float = 0.4,
    add_partners: int | None = None,
    network_type: str = "functional",
) -> CallToolResult:
    """Show an interactive STRING protein interaction network to the user: proteins as nodes clustered by
    interaction density, edges colored by their main evidence (experiments, databases, text mining, coexpression,
    genomic context), with details on hover and links to STRING. Use it for a list of proteins (e.g. ["TP53", "MDM2",
    "CDKN1A", "ATM"]), or for one protein and its top interaction partners (e.g. ["AKT1"]).

    Args:
        proteins: gene names, UniProt accessions or STRING IDs
        species: NCBI taxonomy ID, human (9606) by default
        min_score: minimum combined score of interactions, from 0 to 1: 0.15 low, 0.4 medium, 0.7 high, 0.9 highest
        add_partners: number of top partners added to the queried proteins (max 100), 15 by default for one protein,
            0 for several
        network_type: `functional` (any association) or `physical` (proteins in a complex)
    """
    queries = list(dict.fromkeys(p.strip() for p in proteins if p.strip()))
    if not queries:
        raise ToolError("Give at least one protein, e.g. a gene name like TP53")
    if len(queries) > MAX_PROTEINS:
        raise ToolError(f"At most {MAX_PROTEINS} proteins can be shown, got {len(queries)}")
    if network_type not in ("functional", "physical"):
        raise ToolError("network_type must be `functional` or `physical`")
    # Scores given on the 0-1000 scale of the STRING website are accepted too
    min_score = min_score / 1000 if min_score > 1 else min_score
    partners = add_partners if add_partners is not None else 15 if len(queries) == 1 else 0
    partners = max(0, min(partners, MAX_PARTNERS))

    # Map the queries to STRING IDs, the best match of each
    found = string_api(
        "get_string_ids", {"identifiers": "\r".join(queries), "species": species, "limit": 1, "echo_query": 1}
    )
    if not found:
        raise ToolError(f"None of {', '.join(queries)} found in STRING for species {species}")
    matched = {f["queryItem"] for f in found}
    missing = [q for q in queries if q not in matched]
    infos = {f["stringId"]: f for f in found}
    ids = list(infos)

    # Interactions between the queried proteins and their top partners
    params = {"species": species, "required_score": round(min_score * 1000), "network_type": network_type}
    raw = string_api("network", {**params, "identifiers": "\r".join(ids), "add_nodes": partners})
    edges: dict[tuple[str, str], Edge] = {}
    for e in raw:
        edge = edge_of(e)
        pair = (min(edge["source"], edge["target"]), max(edge["source"], edge["target"]))
        if pair[0] != pair[1] and (pair not in edges or edges[pair]["score"] < edge["score"]):
            edges[pair] = edge

    # Names and annotations of the added partners
    added = list(dict.fromkeys(i for e in edges.values() for i in (e["source"], e["target"]) if i not in infos))
    if added:
        for f in string_api("get_string_ids", {"identifiers": "\r".join(added), "species": species, "limit": 1}):
            infos.setdefault(f["stringId"], f)
    nodes = [
        Node(id=i, name=f["preferredName"], annotation=f.get("annotation") or "", query=i in ids)
        for i, f in infos.items()
    ]
    # Drop edges to IDs STRING could not name, rare but would break the graph
    edge_list = [e for e in edges.values() if e["source"] in infos and e["target"] in infos]

    # Enrichment of interactions among the queried proteins, more than expected for random proteins
    p_value, expected = None, None
    if len(ids) > 1:
        enrichment = string_api("ppi_enrichment", {**params, "identifiers": "\r".join(ids)})
        if enrichment:
            p_value, expected = enrichment[0].get("p_value"), enrichment[0].get("expected_number_of_edges")

    # Summary: counts, hubs, strongest interactions and their evidence
    names = {n["id"]: n["name"] for n in nodes}
    organism = next((f.get("taxonName") for f in found), None)
    degree = Counter(i for e in edge_list for i in (e["source"], e["target"]))
    hubs = ", ".join(f"{names[i]} ({n})" for i, n in degree.most_common(10))
    lonely = [n["name"] for n in nodes if n["query"] and n["id"] not in degree]
    strongest = sorted(edge_list, key=lambda e: e["score"], reverse=True)[:25]
    lines = [
        (
            f"Shown to the user: STRING {network_type} network of {len(nodes)} {organism} proteins "
            f"({len(ids)} queried, {len(nodes) - len(ids)} top partners added), "
            f"{len(edge_list)} interactions with a score >= {min_score}"
        ),
        f"Interactions by main evidence: {', '.join(f'{c}: {n}' for c, n in Counter(e['channel'] for e in edge_list).most_common())}",
        f"Most connected: {hubs or 'none'}",
    ]
    if p_value is not None:
        lines.append(
            f"PPI enrichment p-value of the queried proteins: {p_value:.3g} ({expected} interactions expected)"
        )
    if missing:
        lines.append(f"Not found in STRING: {', '.join(missing)}")
    if lonely:
        lines.append(f"Without interaction at this score: {', '.join(lonely)}")
    lines.append(
        "Strongest interactions (combined score; main channels): "
        + "; ".join(
            f"{names[e['source']]}-{names[e['target']]} {e['score']:.3f} ("
            + ", ".join(f"{c} {s:.2f}" for c, s in sorted(e["scores"].items(), key=lambda x: -x[1]) if s >= 0.3)
            + ")"
            for e in strongest
        )
    )
    lines.append("The user can explore clusters, hover proteins and interactions for details, and ask about them.")

    url = f"{STRING_URL}/cgi/network?identifiers={'%0d'.join(ids)}&species={species}"
    data = NetworkData(
        species=species,
        organism=organism,
        minScore=min_score,
        networkType=network_type,
        nodes=nodes,
        edges=edge_list,
        missing=missing,
        pValue=p_value,
        expectedEdges=expected,
        url=url,
    )
    return text_result("\n".join(lines), data)


apps.add_html_resource(
    "ui://string/network.html",
    widget_html("string-network.html"),
    title="STRING protein network",
)
