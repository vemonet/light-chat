"""NCBI Pathogen Detection tools showing MCP Apps widgets: isolates table and AMR gene heatmap.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
Like every NCBI tool they are async and send their requests through the shared clients of `shared.py`, so they
draw on the same per-IP rate limiter (see `server.py`).
"""

from __future__ import annotations

import asyncio
import difflib
from collections import Counter
from typing import Annotated, Any, TypedDict

from mcp.server.apps import Apps
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, ToolAnnotations
from pydantic import Field

from ..apps_common import WIDGET_CSP, text_result, widget_html
from . import pathogens
from .envelope import NCBIError
from .eutils import TransportError
from .shared import pathogen_client, pathogen_filter

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=True)
# Isolates loaded in the table: ~400 bytes each in structuredContent
MAX_ISOLATES = 2000
# Genes sent to the heatmap, the widget shows the top N of them
MAX_HEATMAP_GENES = 300
ISOLATE_FIELDS = (
    "target_acc,biosample_acc,asm_acc,strain,scientific_name,collection_date,geo_loc_name,"
    "isolation_source,host,epi_type,erd_group,AMR_genotypes,isolate_identifiers"
)
# Common names of organism groups that do not contain them
ORGANISM_ALIASES = {"escherichia coli": "E.coli and Shigella", "e. coli": "E.coli and Shigella"}

apps = Apps()


# Data sent to the widgets in `structuredContent`, as read by `widgets/ncbi-*.html`
class Isolate(TypedDict):
    target: str
    """Pathogen Detection isolate accession, e.g. PDT003433638.1"""
    biosample: str | None
    assembly: str | None
    strain: str | None
    organism: str | None
    date: str | None
    """Collection date, e.g. 2021-10-15 or 2021"""
    location: str | None
    """geo_loc_name, e.g. China: Yunnan"""
    source: str | None
    host: str | None
    epi: str | None
    cluster: str | None
    """SNP cluster, e.g. PDS000015678.333"""
    genes: list[str]
    """AMR gene symbols and point mutations"""


class IsolatesData(TypedDict):
    organism: str
    filters: dict[str, str]
    total: int | None
    """Distinct isolates matching the filters"""
    rows: list[Isolate]


class HeatmapOrganism(TypedDict):
    name: str
    isolates: int


class HeatmapGene(TypedDict):
    gene: str
    counts: list[int]
    """Approximate isolates carrying the gene, per organism in the order of `organisms`"""


class HeatmapData(TypedDict):
    organisms: list[HeatmapOrganism]
    genes: list[HeatmapGene]
    filter: str | None
    topN: int
    totalGenes: int


_organism_groups: list[str] = []


async def resolve_organisms(names: list[str]) -> list[str]:
    """Exact Pathogen Detection organism groups for the names given, case-insensitive or partial"""
    if not _organism_groups:
        ngout = await pathogen_client.retrieve({"limit": 0, "facets": "taxgroup_name[||1|500]"})
        _organism_groups.extend(str(b["val"]) for b in pathogens.facet_buckets(ngout, "taxgroup_name"))
    by_lower = {g.lower(): g for g in _organism_groups}
    resolved = []
    for name in names:
        low = name.strip().lower()
        low = ORGANISM_ALIASES.get(low, low).lower()
        partial = [g for g in _organism_groups if low in g.lower()]
        group = by_lower.get(low) or (partial[0] if len(partial) == 1 else None)
        if not group:
            close = partial or difflib.get_close_matches(name, _organism_groups, n=5, cutoff=0.5)
            hint = f" Did you mean: {', '.join(close)}?" if close else " List them with ncbi_pathogen_organisms."
            raise ToolError(f"{name!r} is not a Pathogen Detection organism group.{hint}")
        resolved.append(group)
    return resolved


def bare_genes(genotypes: Any) -> list[str]:
    """Gene symbols without their status, e.g. blaKPC-2=COMPLETE -> blaKPC-2"""
    return list(dict.fromkeys(str(g).split("=")[0] for g in genotypes or []))


def isolate_of(r: dict[str, Any]) -> Isolate:
    return {
        "target": r["target_acc"],
        "biosample": r.get("biosample_acc"),
        "assembly": r.get("asm_acc"),
        "strain": r.get("strain") or next(iter(r.get("isolate_identifiers") or []), None),
        "organism": r.get("scientific_name"),
        "date": r.get("collection_date"),
        "location": r.get("geo_loc_name"),
        "source": r.get("isolation_source"),
        "host": r.get("host"),
        "epi": r.get("epi_type"),
        "cluster": r.get("erd_group"),
        "genes": bare_genes(r.get("AMR_genotypes")),
    }


def year_of(i: Isolate) -> str:
    date = i["date"] or ""
    return date[:4] if date[:4].isdigit() else "Unknown"


def counts(values: list[Any], top: int = 10) -> str:
    return ", ".join(f"{k}: {n}" for k, n in Counter(values).most_common(top)) or "none"


@apps.tool(resource_uri="ui://ncbi/isolates.html", annotations=READ_ONLY)
async def show_pathogen_isolates_table(
    organism: Annotated[
        str, Field(description="Pathogen Detection organism group, e.g. 'Klebsiella pneumoniae', 'Salmonella enterica'")
    ],
    amr_genes: Annotated[
        str | list[str] | None,
        Field(description="AMR gene symbols to require, OR-ed, e.g. 'blaKPC-2,blaKPC-3' (see ncbi_pathogen_amr_genes)"),
    ] = None,
    country: Annotated[str | None, Field(description="Country of collection, e.g. 'USA', 'China'")] = None,
    year_from: Annotated[int | None, Field(description="Earliest collection year, e.g. 2020")] = None,
    year_to: Annotated[int | None, Field(description="Latest collection year")] = None,
    isolation_source: Annotated[str | None, Field(description="Isolation source, e.g. 'blood', 'urine'")] = None,
    host: Annotated[str | None, Field(description="Host organism, e.g. 'Homo sapiens'")] = None,
    epi_type: Annotated[str | None, Field(description="'clinical' or 'environmental/other'")] = None,
    max_rows: Annotated[int, Field(description="Isolates loaded in the table", ge=1, le=MAX_ISOLATES)] = 1000,
) -> CallToolResult:
    """Show NCBI Pathogen Detection isolates to the user in an interactive table, the most recently added first: strain,
    collection date, location, isolation source, host, AMR genes, with links to the isolate and BioSample pages.
    Facets on country, year, isolation source and AMR genes, the user can select rows and send them back to you.
    Use it to browse or pick isolates, e.g. carbapenem resistant Klebsiella pneumoniae from the USA since 2020.
    Only a summary is returned to you (total, counts by facet, first rows)"""
    _, clauses = pathogen_filter(organism, amr_genes, host, isolation_source, epi_type)
    if country:
        clauses["geo_loc_name"] = [country]
    try:
        clauses["taxgroup_name"] = await resolve_organisms([organism])
        # Collection years as a date range, the filter syntax only has == for values
        dates = [f'collection_date>="{year_from}"'] if year_from else []
        dates += [f'collection_date<="{year_to}-12-31"'] if year_to else []
        fq = " and ".join(c for c in [pathogens.build_fq(clauses), *dates] if c)
        count, page = await asyncio.gather(
            pathogen_client.retrieve(pathogens.count_params(fq)),
            pathogen_client.retrieve(pathogens.record_params(fq, limit=max_rows, fl=ISOLATE_FIELDS)),
        )
    except (NCBIError, TransportError) as exc:
        raise ToolError(f"NCBI Pathogen Detection request failed: {exc}") from exc
    total = pathogens.distinct_count(count)
    rows = [isolate_of(r) for r in pathogens.records(page)[:max_rows]]

    filters = {k: ", ".join(v) for k, v in clauses.items()}
    if year_from or year_to:
        filters["collection_year"] = f"{year_from or '...'}-{year_to or '...'}"
    described = "; ".join(f"{k}={v}" for k, v in filters.items())
    if not rows:
        raise ToolError(
            f"No isolate matches {described}. Values are matched literally: check gene symbols with "
            "ncbi_pathogen_amr_genes, and try a broader filter."
        )
    first = "; ".join(
        f"{i['target']} ({i['biosample']}, {i['strain'] or '-'}, {i['location'] or '-'}, {i['date'] or '-'}, "
        f"{i['source'] or '-'})"
        for i in rows[:10]
    )
    text = "\n".join(
        [
            f"Shown to the user in a table: the {len(rows)} most recently added of {total} isolates ({described})",
            f"Countries: {counts([(i['location'] or 'Unknown').split(':')[0] for i in rows])}",
            f"Collection years: {counts([year_of(i) for i in rows])}",
            f"Isolation sources: {counts([i['source'] or 'Unknown' for i in rows], 8)}",
            f"AMR genes: {counts([g for i in rows for g in i['genes']], 20)}",
            f"First rows: {first}",
            "The user can filter, sort and select rows in the table, the selection is sent to you.",
        ]
    )
    return text_result(
        text, IsolatesData(organism=clauses["taxgroup_name"][0], filters=filters, total=total, rows=rows)
    )


@apps.tool(resource_uri="ui://ncbi/amr-heatmap.html", annotations=READ_ONLY)
async def show_amr_heatmap(
    organisms: Annotated[
        list[str],
        Field(
            description="Pathogen Detection organism groups compared, e.g. "
            "['Salmonella enterica', 'E.coli and Shigella', 'Klebsiella pneumoniae']"
        ),
    ],
    gene_filter: Annotated[
        str | None,
        Field(description="Case-insensitive substring of the gene symbols shown, e.g. 'bla', 'KPC', 'mcr', 'van'"),
    ] = None,
    top_n: Annotated[int, Field(description="Genes shown first, the most prevalent", ge=1, le=MAX_HEATMAP_GENES)] = 40,
) -> CallToolResult:
    """Show a heatmap of AMR genes (rows) by organism (columns) to the user, with the share and number of isolates
    of each organism carrying each gene in NCBI Pathogen Detection. The user can switch between share and counts,
    hover cells for details and click them to ask you about a gene in an organism.
    Use it to compare resistance gene prevalence across pathogens, e.g. beta-lactamases with gene_filter='bla'"""
    names = list(dict.fromkeys(o.strip() for o in organisms if o.strip()))[:20]
    if not names:
        raise ToolError("No organism given, e.g. ['Klebsiella pneumoniae', 'E.coli and Shigella']")
    try:
        groups = list(dict.fromkeys(await resolve_organisms(names)))
        # One request per organism: gene buckets and the distinct isolate count together
        results = await asyncio.gather(
            *(
                pathogen_client.retrieve(
                    {
                        "limit": 0,
                        "fq": pathogens.build_fq({"taxgroup_name": [g]}),
                        "facets": "AMR_genotypes[||1|20000],target_acc[||1|1]",
                    }
                )
                for g in groups
            )
        )
    except (NCBIError, TransportError) as exc:
        raise ToolError(f"NCBI Pathogen Detection request failed: {exc}") from exc

    # Gene counts per organism, halved: the index stores every isolate twice
    needle = (gene_filter or "").strip().lower()
    per_org: list[dict[str, int]] = []
    for ngout in results:
        buckets = pathogens.facet_buckets(ngout, "AMR_genotypes")
        per_org.append(
            {
                str(b["val"]): round(int(b["count"]) / 2)
                for b in buckets
                if "=" not in str(b["val"]) and needle in str(b["val"]).lower()
            }
        )
    isolates = [pathogens.distinct_count(ngout) or 0 for ngout in results]
    all_genes = {g for counts_ in per_org for g in counts_}
    if not all_genes:
        raise ToolError(f"No AMR gene matching {gene_filter!r} in {', '.join(groups)}, try a shorter gene_filter")

    # Most prevalent first: highest share of isolates in any organism
    def max_share(gene: str) -> float:
        return max(c.get(gene, 0) / n if n else 0 for c, n in zip(per_org, isolates, strict=True))

    ranked = sorted(all_genes, key=max_share, reverse=True)[:MAX_HEATMAP_GENES]
    genes = [HeatmapGene(gene=g, counts=[c.get(g, 0) for c in per_org]) for g in ranked]
    orgs = [HeatmapOrganism(name=g, isolates=n) for g, n in zip(groups, isolates, strict=True)]

    def share(count: int, n: int) -> str:
        x = count / n if n else 0
        return "<0.1%" if 0 < x < 0.001 else f"{x:.1%}" if x < 0.1 else f"{x:.0%}"

    lines = [
        f"Shown to the user: heatmap of the {min(top_n, len(genes))} most prevalent of {len(all_genes)} AMR genes"
        + (f" matching {gene_filter!r}" if gene_filter else "")
        + f" in {len(orgs)} organism groups of NCBI Pathogen Detection (isolate counts are approximate: index rows / 2)",
    ]
    for i, o in enumerate(orgs):
        top = sorted(genes, key=lambda g: g["counts"][i], reverse=True)[:12]
        listed = ", ".join(
            f"{g['gene']} {share(g['counts'][i], o['isolates'])} ({g['counts'][i]:,})" for g in top if g["counts"][i]
        )
        lines.append(f"- {o['name']} ({o['isolates']:,} isolates): {listed or 'none'}")
    lines.append("The user can hover and click cells to ask you about a gene in an organism.")
    data = HeatmapData(organisms=orgs, genes=genes, filter=gene_filter, topN=top_n, totalGenes=len(all_genes))
    return text_result("\n".join(lines), data)


apps.add_html_resource(
    "ui://ncbi/isolates.html",
    widget_html("ncbi-isolates.html"),
    title="NCBI Pathogen Detection isolates",
    csp=WIDGET_CSP,
)
apps.add_html_resource(
    "ui://ncbi/amr-heatmap.html", widget_html("ncbi-amr-heatmap.html"), title="AMR gene heatmap", csp=WIDGET_CSP
)
