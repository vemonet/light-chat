"""BRC Analytics tools showing MCP Apps widgets: compatibility matrix of genome assemblies and analysis workflows.

The catalog (organisms, assemblies, workflows) is only served by BRC Analytics' public MCP server, it has no REST
endpoint: the tool calls that server. The widget gets the full data in `structuredContent`, the model only gets a
text summary.
"""

import asyncio
import html
from collections import Counter
from typing import Any, Literal, TypedDict

from mcp import Client
from mcp.server.apps import Apps
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult

from .apps_common import text_result, widget_html

# The trailing slash is required, without it the server redirects to plain http
BRC_MCP = "https://brc-analytics.org/api/v1/mcp/"
BRC_SITE = "https://brc-analytics.org"
# Every ploidy, to list all workflows with `get_compatible_workflows`
PLOIDIES = ["HAPLOID", "DIPLOID", "POLYPLOID", "ANY"]
MAX_ORGANISMS = 10
MAX_ASSEMBLIES = 60
LEVELS = ["Complete Genome", "Chromosome", "Scaffold", "Contig"]
# Human readable workflow inputs, by the variable of their parameter
INPUTS = {
    "ASSEMBLY_FASTA_URL": "Genome FASTA",
    "ASSEMBLY_ID": "Assembly accession",
    "GENE_MODEL_URL": "Gene model (GTF)",
    "SANGER_READ_RUN_PAIRED": "Paired-end reads",
    "SANGER_READ_RUN_SINGLE": "Single-end reads",
}

apps = Apps()


# Data sent to the widget in `structuredContent`, as read by `widgets/brc-matrix.html`
class BrcOrganism(TypedDict):
    taxonomyId: str
    species: str
    assemblyCount: int


class BrcAssembly(TypedDict):
    accession: str
    species: str
    strain: str | None
    taxonomyId: str
    organismTaxonomyId: str
    level: str | None
    ploidy: list[str]
    isRef: bool
    length: int | None
    gcPercent: float | None
    scaffolds: int | None
    geneModel: bool
    ucscUrl: str | None


class BrcWorkflow(TypedDict):
    iwcId: str
    name: str
    description: str
    categories: list[str]
    ploidy: str | None
    taxonomyId: str | None
    """Taxon the workflow is restricted to, assemblies must descend from it"""
    trsId: str
    inputs: list[str]
    """e.g. "Paired-end reads (WGS)", "Gene model (GTF)" """


Status = Literal["ready", "no_gene_model", "ploidy", "taxonomy"]


class BrcMatrixData(TypedDict):
    query: str
    organisms: list[BrcOrganism]
    assemblies: list[BrcAssembly]
    assemblyTotal: int
    workflows: list[BrcWorkflow]
    categories: list[dict[str, str]]
    """[{"name": "Variant calling", "description": "..."}] in the catalog order"""
    status: dict[str, list[Status]]
    """Accession -> status of each workflow, in the order of `workflows`: compatible (`ready`, or `no_gene_model` when
    the workflow needs one), or the mismatch (`ploidy`, `taxonomy`)"""


async def call(client: Client, tool: str, args: dict[str, Any]) -> Any:
    """Structured result of a tool of the BRC Analytics MCP server"""
    res = await client.call_tool(tool, args)
    if res.is_error or res.structured_content is None:
        text = " ".join(c.text for c in res.content if c.type == "text")
        raise ToolError(f"BRC Analytics {tool} failed: {text[:300]}")
    return res.structured_content


def workflow_of(w: dict[str, Any]) -> BrcWorkflow:
    inputs = []
    for p in w.get("parameters") or []:
        label = INPUTS.get(p.get("variable"), p.get("key", ""))
        strategies = (p.get("data_requirements") or {}).get("library_strategy") or []
        inputs.append(f"{label} ({', '.join(strategies)})" if strategies else label)
    return BrcWorkflow(
        iwcId=w["iwcId"],
        name=html.unescape(w.get("name") or w["iwcId"]),
        description=html.unescape(w.get("description") or ""),
        categories=w.get("categories") or [w.get("category") or "Other"],
        ploidy=w.get("ploidy"),
        taxonomyId=str(w["taxonomyId"]) if w.get("taxonomyId") is not None else None,
        trsId=w.get("trsId") or "",
        inputs=list(dict.fromkeys(inputs)),
    )


def assembly_of(a: dict[str, Any], organism: str) -> BrcAssembly:
    gene_model = a.get("geneModelUrl")
    return BrcAssembly(
        accession=a["accession"],
        species=a.get("species") or "",
        strain=a.get("strain"),
        taxonomyId=str(a.get("ncbiTaxonomyId") or organism),
        organismTaxonomyId=organism,
        level=a.get("level"),
        ploidy=a.get("ploidy") or [],
        isRef=a.get("isRef") == "Yes",
        length=a.get("length"),
        gcPercent=a.get("gcPercent"),
        scaffolds=a.get("scaffoldCount"),
        # The catalog uses the string "None" for missing gene models
        geneModel=bool(gene_model) and gene_model != "None",
        ucscUrl=a.get("ucscBrowserUrl"),
    )


def status_of(w: BrcWorkflow, a: BrcAssembly, taxon_ok: bool) -> Status:
    """Same rules as the BRC Analytics `check_compatibility` tool, plus the gene model some workflows need"""
    if w["ploidy"] not in (None, "ANY") and w["ploidy"] not in a["ploidy"]:
        return "ploidy"
    if not taxon_ok:
        return "taxonomy"
    if "Gene model (GTF)" in w["inputs"] and not a["geneModel"]:
        return "no_gene_model"
    return "ready"


async def find_organisms(client: Client, organism: str) -> list[BrcOrganism]:
    """Organisms by taxonomy ID, exact species name, or all the matches of a name (e.g. a genus)"""
    if organism.isdigit():
        try:
            orgs = [await call(client, "get_organism", {"taxonomy_id": organism})]
        except ToolError:
            return []
    else:
        orgs = (await call(client, "search_organisms", {"query": organism, "limit": 50}))["organisms"]
        exact = [o for o in orgs if (o.get("species") or "").lower() == organism.lower()]
        orgs = exact or orgs
    return [
        BrcOrganism(
            taxonomyId=str(o["ncbiTaxonomyId"]), species=o.get("species") or "", assemblyCount=o["assemblyCount"]
        )
        for o in orgs
    ]


def assembly_rank(a: BrcAssembly) -> tuple[Any, ...]:
    """Reference first, then the most complete"""
    level = LEVELS.index(a["level"]) if a["level"] in LEVELS else len(LEVELS)
    return (not a["isRef"], level, not a["geneModel"], a["accession"])


async def fetch_matrix(client: Client, organism: str) -> tuple[Any, ...]:
    """Organisms matching, workflows, categories, assemblies (best first), their total, and the workflows matching
    the taxonomy of each assembly taxon"""
    organisms = await find_organisms(client, organism)
    if not organisms:
        raise ToolError(
            f"No organism matching {organism!r} in BRC Analytics. It hosts selected pathogens and hosts, "
            "search with a species or genus name, e.g. Klebsiella pneumoniae, Plasmodium"
        )
    organisms = sorted(organisms, key=lambda o: -o["assemblyCount"])[:MAX_ORGANISMS]
    # Assemblies of each organism, every workflow, and the categories in parallel
    results = await asyncio.gather(
        call(client, "get_compatible_workflows", {"ploidies": PLOIDIES}),
        call(client, "list_workflow_categories", {}),
        *(call(client, "get_assemblies", {"taxonomy_id": o["taxonomyId"]}) for o in organisms),
    )
    workflows = [workflow_of(w) for w in results[0]["workflows"]]
    categories = [
        {"name": c["name"], "description": c.get("description") or ""}
        for c in results[1]["categories"]
        if any(c["name"] in w["categories"] for w in workflows)
    ]
    seen: set[str] = set()
    assemblies: list[BrcAssembly] = []
    for o, res in zip(organisms, results[2:], strict=True):
        for a in res["assemblies"]:
            if a["accession"] not in seen:
                seen.add(a["accession"])
                assemblies.append(assembly_of(a, o["taxonomyId"]))
    total = len(assemblies)
    assemblies = sorted(assemblies, key=assembly_rank)[:MAX_ASSEMBLIES]
    if not assemblies:
        raise ToolError(f"BRC Analytics has no assembly for {', '.join(o['species'] for o in organisms)}")

    # Workflows matching the lineage of each assembly taxon, the ploidy is checked locally
    taxa = list(dict.fromkeys(a["taxonomyId"] for a in assemblies))
    matching = await asyncio.gather(
        *(call(client, "get_compatible_workflows", {"ploidies": PLOIDIES, "taxonomy_id": t}) for t in taxa)
    )
    taxon_ok = {t: {w["iwcId"] for w in res["workflows"]} for t, res in zip(taxa, matching, strict=True)}
    return organisms, workflows, categories, assemblies, total, taxon_ok


@apps.tool(resource_uri="ui://brc-analytics/matrix.html")
async def show_brc_workflow_matrix(organism: str) -> CallToolResult:
    """Show to the user a matrix of the genome assemblies of an organism in BRC Analytics (rows) against the Galaxy
    analysis workflows they can run (columns, grouped by category: variant calling, transcriptomics, regulation,
    annotation...), with assembly metadata (strain, assembly level, reference genome) and links to configure the
    workflow on BRC Analytics. `organism` is a species name (e.g. "Klebsiella pneumoniae"), a genus (e.g.
    "Plasmodium", all its species) or an NCBI taxonomy ID (e.g. "573"). Use it to answer which analyses can be run on
    which genomes of an organism"""
    organism = organism.strip()
    if not organism:
        raise ToolError("Give an organism name (e.g. Escherichia coli) or an NCBI taxonomy ID (e.g. 562)")
    async with Client(BRC_MCP, mode="legacy") as client:
        # Errors raised once the client is closed, it would wrap them in an exception group
        try:
            fetched = await fetch_matrix(client, organism)
        except ToolError as e:
            fetched = e
    if isinstance(fetched, ToolError):
        raise fetched
    organisms, workflows, categories, assemblies, total, taxon_ok = fetched
    status = {
        a["accession"]: [status_of(w, a, w["iwcId"] in taxon_ok[a["taxonomyId"]]) for w in workflows]
        for a in assemblies
    }

    # Summary for the model: assemblies, and the workflows each can run
    names = ", ".join(f"{o['species']} (taxid {o['taxonomyId']})" for o in organisms)
    shown = f"{len(assemblies)} of {total} BRC Analytics assemblies of {names}"
    lines = [f"Shown to the user: workflow compatibility matrix of {shown} against {len(workflows)} workflows"]
    for a in assemblies[:30]:
        ready = Counter(status[a["accession"]])
        meta = ", ".join(filter(None, [a["strain"], a["level"], "reference" if a["isRef"] else None]))
        lines.append(
            f"- {a['accession']} ({meta}): {ready['ready']} workflows ready"
            + (f", {ready['no_gene_model']} need a gene model it lacks" if ready["no_gene_model"] else "")
        )
    # Workflows by the assemblies they are ready on
    on_all, incompatible = [], []
    for i, w in enumerate(workflows):
        ok = [a["accession"] for a in assemblies if status[a["accession"]][i] == "ready"]
        label = f"{w['iwcId']} ({w['name']}, {', '.join(w['categories'])})"
        if len(ok) == len(assemblies):
            on_all.append(label)
        elif ok:
            more = f" +{len(ok) - 10} more" if len(ok) > 10 else ""
            lines.append(f"Workflow {label}: ready on {', '.join(ok[:10])}{more}")
        elif all(status[a["accession"]][i] in ("ploidy", "taxonomy") for a in assemblies):
            incompatible.append(w["iwcId"])
    lines.append(f"Workflows ready on all these assemblies: {'; '.join(on_all) or 'none'}")
    lines.append(f"Workflows not compatible with these assemblies: {', '.join(incompatible) or 'none'}")
    lines.append("The user can click a cell to ask you about running a workflow on an assembly.")
    data = BrcMatrixData(
        query=organism,
        organisms=organisms,
        assemblies=assemblies,
        assemblyTotal=total,
        workflows=workflows,
        categories=categories,
        status=status,
    )
    return text_result("\n".join(lines), data)


apps.add_html_resource(
    "ui://brc-analytics/matrix.html", widget_html("brc-matrix.html"), title="BRC Analytics workflow matrix"
)
