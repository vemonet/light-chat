"""NIAID Data Ecosystem tools showing MCP Apps widgets: dataset search results table.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any, TypedDict

from mcp.server.apps import Apps
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, ToolAnnotations

from ..apps_common import WIDGET_CSP, text_result, widget_html
from .client import PORTAL_RESOURCE_URL, NDEError, get_client
from .format import first_name, format_facets, names_of, truncate
from .query import build_clauses, build_params, join_clauses, normalize_sort

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=True)
# Rows loaded in the table: ~700 bytes each in structuredContent
MAX_ROWS = 1000
DESCRIPTION_CHARS = 300
SOURCE = [
    "_id",
    "@type",
    "name",
    "description",
    "date",
    "url",
    "doi",
    "includedInDataCatalog.name",
    "includedInDataCatalog.archivedAt",
    "infectiousAgent.name",
    "species.name",
    "healthCondition.name",
    "measurementTechnique.name",
    "conditionsOfAccess",
]
# Counted over all the matches, for the summary of the model
FACETS = ["includedInDataCatalog.name", "infectiousAgent.name", "species.name", "measurementTechnique.name"]

apps = Apps()


# Data sent to the widget in `structuredContent`, as read by `widgets/nde-datasets.html`
class DatasetRow(TypedDict):
    id: str
    type: str | None
    name: str | None
    description: str | None
    date: str | None
    repository: str | None
    url: str | None
    """Record page in the source repository"""
    doi: str | None
    pathogens: list[str]
    species: list[str]
    conditions: list[str]
    techniques: list[str]
    access: str | None


class DatasetsData(TypedDict):
    query: str
    """Lucene query sent to the NDE API"""
    filters: dict[str, str]
    """Arguments of the search, e.g. {"query": "carbapenem resistance", "pathogen": "..."}"""
    total: int
    portal: str
    """Portal URL of a record, with `{_id}`"""
    rows: list[DatasetRow]


def split(value: str | None) -> list[str]:
    """Comma-separated values of a filter, OR-ed"""
    return [v.strip() for v in (value or "").split(",") if v.strip()]


def plain(text: str | None) -> str | None:
    """Text without the HTML tags some repositories put in titles, e.g. <i>"""
    return re.sub(r"<[^>]+>", "", text) if text else text


def row_of(hit: dict[str, Any]) -> DatasetRow:
    catalog = hit.get("includedInDataCatalog")
    catalog = catalog[0] if isinstance(catalog, list) and catalog else catalog
    catalog = catalog if isinstance(catalog, dict) else {}
    name = hit.get("name")
    return {
        "id": hit["_id"],
        "type": first_name(hit.get("@type")),
        "name": plain(name if isinstance(name, str) else first_name(name)),
        "description": truncate(plain(hit.get("description")), DESCRIPTION_CHARS),
        "date": str(hit["date"])[:10] if hit.get("date") else None,
        "repository": catalog.get("name"),
        "url": catalog.get("archivedAt") or first_name(hit.get("url")),
        "doi": first_name(hit.get("doi")),
        "pathogens": names_of(hit.get("infectiousAgent"), limit=5),
        "species": names_of(hit.get("species"), limit=5),
        "conditions": names_of(hit.get("healthCondition"), limit=5),
        "techniques": names_of(hit.get("measurementTechnique"), limit=5),
        "access": first_name(hit.get("conditionsOfAccess")),
    }


@apps.tool(resource_uri="ui://nde/datasets.html", annotations=READ_ONLY)
async def search_datasets_table(
    query: str = "",
    pathogen: str | None = None,
    host_species: str | None = None,
    health_condition: str | None = None,
    measurement_technique: str | None = None,
    repository: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    record_type: str = "Dataset",
    sort: str = "relevance",
    max_rows: int = 500,
) -> CallToolResult:
    """Search the NIAID Data Ecosystem (~14M datasets from NCBI, Zenodo, Figshare, ImmPort, dbGaP...) and show the
    results to the user in an interactive table with facets for repository, pathogen, species and year, and links to
    the NDE portal and the source repository. The user can filter, sort and select rows and send them back to you.
    Use it when the user wants to browse or pick datasets, e.g. "carbapenem resistance" datasets. Only a summary is
    returned to you (total, counts by repository, pathogen and species, first rows).

    Args:
        query: Free-text terms with Lucene operators, e.g. "carbapenem resistance". Empty to browse by filters.
        pathogen: Infectious agent, e.g. "Klebsiella pneumoniae". Comma-separated values are OR-ed, as for all filters
        host_species: Organism studied, e.g. "Homo sapiens"
        health_condition: Disease, e.g. "tuberculosis"
        measurement_technique: Assay, e.g. "whole genome sequencing assay" for datasets
        repository: e.g. "NCBI SRA", "Zenodo", list them with nde_list_repositories
        date_from: Earliest date, YYYY or YYYY-MM-DD
        date_to: Latest date
        record_type: Dataset (default), ComputationalTool, ResourceCatalog, DataCollection, Sample, or "any"
        sort: relevance (default), newest, oldest, recently_updated or name
        max_rows: Rows loaded in the table, 1-1000
    """
    record = None if record_type.strip().lower() in ("", "any", "all") else record_type
    clauses = build_clauses(
        query,
        filters={
            "record_type": record,
            "pathogen": split(pathogen),
            "host_species": split(host_species),
            "health_condition": split(health_condition),
            "measurement_technique": split(measurement_technique),
            "repository": split(repository),
        },
        date_from=date_from,
        date_to=date_to,
    )
    q = join_clauses(clauses)
    params = build_params(
        q,
        size=max(1, min(max_rows, MAX_ROWS)),
        offset=0,
        source=SOURCE,
        sort=normalize_sort(sort),
        facets=FACETS,
        facet_size=8,
    )
    try:
        payload = await get_client().query(params)
    except NDEError as exc:
        raise ToolError(f"NDE search failed for `{q}`: {exc}") from exc
    total = int(payload.get("total") or 0)
    rows = [row_of(h) for h in payload.get("hits") or [] if h.get("_id")]
    if not rows:
        raise ToolError(
            f"No record matches `{q}`. Try fewer filters or a broader query, nde_facet_counts lists the values of a "
            "filter that exist (vocabularies differ by record type)."
        )

    # Summary: counts over all matches, then the first rows
    facets = format_facets(payload.get("facets") or {})

    def top(field: str) -> str:
        values = facets.get(field, {}).get("values", [])
        return ", ".join(f"{v['value']}: {v['count']}" for v in values) or "none"

    years = Counter((r["date"] or "")[:4] or "Unknown" for r in rows).most_common(8)
    first = "; ".join(f"{r['id']} {r['name']} ({r['repository']}, {r['date'] or '-'})" for r in rows[:10])
    text = "\n".join(
        [
            f"Shown to the user in a table: {len(rows)} of {total} NDE records matching `{q}`",
            f"Repositories (all matches): {top('includedInDataCatalog.name')}",
            f"Pathogens (all matches): {top('infectiousAgent.name')}",
            f"Species (all matches): {top('species.name')}",
            f"Measurement techniques (all matches): {top('measurementTechnique.name')}",
            f"Years (rows shown): {', '.join(f'{y}: {n}' for y, n in years)}",
            f"First rows: {first}",
            "The user can filter, sort and select rows in the table, the selection is sent to you.",
            "nde_get_record gives the full metadata of a record by its id.",
        ]
    )
    args = {
        "query": query,
        "pathogen": pathogen,
        "species": host_species,
        "condition": health_condition,
        "technique": measurement_technique,
        "repository": repository,
        "from": date_from,
        "to": date_to,
        "type": None if record == "Dataset" else record,
    }
    filters = {k: v.strip() for k, v in args.items() if v and v.strip()}
    data = DatasetsData(query=q, filters=filters, total=total, portal=PORTAL_RESOURCE_URL, rows=rows)
    return text_result(text, data)


apps.add_html_resource(
    "ui://nde/datasets.html", widget_html("nde-datasets.html"), title="NDE dataset search results", csp=WIDGET_CSP
)
