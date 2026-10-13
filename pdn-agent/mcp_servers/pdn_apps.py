"""PDN tools showing MCP Apps widgets over LAPIS data: mutation or lineage frequencies over time, a world map of
sequence counts, and a lollipop plot of the mutations along the genome.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
"""

import difflib
import math
from typing import Any, Literal, TypedDict

from mcp.server.apps import Apps, ResourceCsp
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult

from .apps_common import CDN, text_result, widget_html
from .lapis import (
    LAPIS_MAX_FILTER_DOWNLOAD_BYTES,
    LAPIS_MUTATION_FIELDS,
    LapisResponseTooLarge,
    _lapis_check_filters,
    _lapis_date_field,
    _lapis_date_ranges,
    _lapis_organism,
    _lapis_post,
    _lapis_schema,
    _lapis_unknown_field,
    _lapis_version_filter,
)

# z of a 95% Wilson score interval
Z95 = 1.96
MAX_SERIES = 8
MAX_LOLLIPOPS = 1000
# Fields tried first when the organism has several country or lineage fields
COUNTRY_FIELDS = ["country", "geoLocCountry"]
LINEAGE_FIELDS = ["pangoLineage", "lineage", "outbreakLineage", "clade"]
# LAPIS lists the SARS-CoV-2 genes alphabetically, the lollipop shows them in genome order
GENOME_ORDER = {
    "sars-cov-2": ["ORF1a", "ORF1b", "S", "ORF3a", "E", "M", "ORF6", "ORF7a", "ORF7b", "ORF8", "N", "ORF9b"],
}

apps = Apps()


# Data sent to the widgets in `structuredContent`, as read by `widgets/pdn-*.html`
class Period(TypedDict):
    start: str
    end: str
    total: int
    """Sequences with a date in the period"""


class Series(TypedDict):
    name: str
    kind: Literal["mutation", "lineage"]
    count: list[int]
    coverage: list[int]
    """Sequences covering the mutation position, or all sequences of the period for a lineage"""
    proportion: list[float | None]
    lower: list[float | None]
    """Wilson 95% interval of the proportion"""
    upper: list[float | None]


class OverTimeData(TypedDict):
    organism: str
    database: str
    filters: dict[str, Any]
    date_field: str
    interval: str
    lineage_field: str | None
    periods: list[Period]
    series: list[Series]


class CountryCount(TypedDict):
    country: str
    count: int


class CountryData(TypedDict):
    organism: str
    database: str
    filters: dict[str, Any]
    country_field: str
    total: int
    unknown: int
    """Sequences without a country"""
    rows: list[CountryCount]


class Region(TypedDict):
    name: str
    length: int


class Lollipop(TypedDict):
    mutation: str
    region: str
    position: int
    count: int
    coverage: int
    proportion: float


class LollipopData(TypedDict):
    organism: str
    database: str
    filters: dict[str, Any]
    sequence_type: str
    min_proportion: float
    total: int
    """Sequences matching the filters"""
    regions: list[Region]
    """Genes or segments in genome order, with their length in amino acids or nucleotides"""
    mutations: list[Lollipop]
    truncated: bool


def wilson(count: int, n: int) -> tuple[float | None, float | None]:
    """Wilson score 95% interval of a proportion, sound with small `n` and proportions near 0 or 1"""
    if not n:
        return None, None
    p = count / n
    denominator = 1 + Z95**2 / n
    center = (p + Z95**2 / (2 * n)) / denominator
    half = Z95 * math.sqrt(p * (1 - p) / n + Z95**2 / (4 * n * n)) / denominator
    return round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)


def series_of(name: str, kind: Literal["mutation", "lineage"], counts: list[int], coverages: list[int]) -> Series:
    intervals = [wilson(c, n) for c, n in zip(counts, coverages, strict=True)]
    return Series(
        name=name,
        kind=kind,
        count=counts,
        coverage=coverages,
        proportion=[round(c / n, 4) if n else None for c, n in zip(counts, coverages, strict=True)],
        lower=[lo for lo, _ in intervals],
        upper=[hi for _, hi in intervals],
    )


def pick_field(schema: dict, field: str, preferred: list[str], what: str, candidates: list[str]) -> str:
    """The field given, else the first preferred one the organism has, else the first candidate"""
    if field:
        if field not in schema["fields"]:
            raise _lapis_unknown_field(schema, field)
        return field
    found = next((f for f in [*preferred, *candidates] if f in schema["fields"]), None)
    if not found:
        raise ToolError(f"{schema['instance_name']} has no {what} field. Pass one, see lapis_describe_organism.")
    return found


def query_filters(schema: dict, filters: dict[str, Any] | None, latest_version_only: bool) -> dict[str, Any]:
    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    _lapis_version_filter(schema, body, latest_version_only)
    return body


def pct(p: float | None) -> str:
    return "-" if p is None else f"{p * 100:.1f}%"


def filters_text(filters: dict[str, Any]) -> str:
    return ", ".join(f"{k}={v}" for k, v in filters.items() if k not in ("versionStatus", "isRevocation")) or "none"


# ********** mutations and lineages over time **********


def check_mutations(schema: dict, sequence_type: str, mutations: list[str]) -> None:
    """Check the gene or segment prefix, LAPIS answers a malformed mutation with "Failed to read request" """
    names, kind = (schema["genes"], "gene") if sequence_type == "amino_acid" else (schema["segments"], "segment")
    shown = ", ".join(names[:10]) + (", ..." if len(names) > 10 else "")
    for mutation in mutations:
        prefix = mutation.split(":")[0] if ":" in mutation else ""
        if prefix and prefix not in names:
            raise ToolError(
                f"'{mutation}' starts with '{prefix}', which is not a {kind} of {schema['instance_name']}. "
                f"Its {kind}s: {shown}. Set sequence_type to 'nucleotide' for a nucleotide mutation."
            )
        if not prefix and (kind == "gene" or len(names) > 1):
            example = f"{names[0]}:N50Y" if kind == "gene" else f"{names[0]}:A123G"
            raise ToolError(f"'{mutation}' needs a {kind} before the position, e.g. '{example}'.")


def counts_by_period(url: str, body: dict, date_field: str, periods: list[Period]) -> list[int]:
    """Sequences per period, from one LAPIS count grouped by date"""
    query = {**body, f"{date_field}From": periods[0]["start"], f"{date_field}To": periods[-1]["end"]}
    rows, _ = _lapis_post(f"{url}/sample/aggregated", {**query, "fields": [date_field]})
    counts = [0] * len(periods)
    for row in rows:
        day = row[date_field]
        i = next((i for i, p in enumerate(periods) if p["start"] <= day <= p["end"]), None) if day else None
        if i is not None:
            counts[i] += row["count"]
    return counts


@apps.tool(resource_uri="ui://pdn/over-time.html")
def show_lapis_mutations_over_time(
    organism: str,
    date_from: str,
    date_to: str,
    mutations: list[str] | None = None,
    lineages: list[str] | None = None,
    sequence_type: Literal["amino_acid", "nucleotide"] = "amino_acid",
    interval: Literal["month", "quarter", "year"] = "month",
    filters: dict[str, Any] | None = None,
    lineage_field: str = "",
    date_field: str = "",
    latest_version_only: bool = True,
) -> CallToolResult:
    """Show the user a line chart of the frequency of mutations and/or lineages over time, in the sequences of an
    organism matching the filters, with a 95% confidence band from the number of sequences of each period. Use it to see
    whether a mutation or lineage grows or fades, e.g. "Is S:L455S growing in Switzerland in 2024?".

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "sars-cov-2" or "mpox".
        date_from: The first date, e.g. "2024-01-01".
        date_to: The last date, e.g. "2024-12-31".
        mutations: Mutations to track, e.g. ["S:L455S", "S:F456L"], with the gene (or the segment of a multi-segment
            organism) before the position. lapis_get_mutations finds them.
        lineages: Lineages to track, e.g. ["JN.1*", "KP.2*"], "*" includes the sublineages. Mutations and lineages can
            be combined, up to 8 series.
        sequence_type: "amino_acid" (default) or "nucleotide", the type of all the mutations.
        interval: "month" (default), "quarter" or "year".
        filters: As in lapis_aggregate_samples, e.g. {"country": "Switzerland"} for sars-cov-2,
            {"geoLocCountry": "USA"} for Pathoplexus organisms.
        lineage_field: The field of the lineages, e.g. "nextstrainClade". Empty picks the main lineage field, e.g.
            pangoLineage for sars-cov-2, lineage for mpox.
        date_field: The date field to count over. Empty picks the collection date.
        latest_version_only: Count each sequence once, skipping older versions and revocations (default True).
    """
    mutations, lineages = mutations or [], lineages or []
    if not mutations and not lineages:
        raise ToolError("Name at least one mutation or lineage. lapis_get_mutations lists the common mutations.")
    if len(mutations) + len(lineages) > MAX_SERIES:
        raise ToolError(f"Name at most {MAX_SERIES} mutations and lineages in all, so the chart stays readable.")
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    check_mutations(schema, sequence_type, mutations)
    body = query_filters(schema, filters, latest_version_only)
    field = _lapis_date_field(schema, date_field)
    ranges = _lapis_date_ranges(date_from, date_to, interval)
    periods = [Period(start=r["dateFrom"], end=r["dateTo"], total=0) for r in ranges]
    series: list[Series] = []

    # Mutations: count and coverage per period from the LAPIS component
    if mutations:
        endpoint = "aminoAcidMutationsOverTime" if sequence_type == "amino_acid" else "nucleotideMutationsOverTime"
        query = {"filters": body, "includeMutations": mutations, "dateRanges": ranges, "dateField": field}
        result, _ = _lapis_post(f"{url}/component/{endpoint}", query)
        for p, total in zip(periods, result["totalCountsByDateRange"], strict=True):
            p["total"] = total
        for name, points in zip(result["mutations"], result["data"], strict=True):
            series.append(series_of(name, "mutation", [p["count"] for p in points], [p["coverage"] for p in points]))

    # Lineages: sequences of the lineage over all the sequences of each period
    lineage_name = None
    if lineages:
        lineage_name = pick_field(schema, lineage_field, LINEAGE_FIELDS, "lineage", schema["lineage_fields"])
        totals = counts_by_period(url, body, field, periods)
        if not mutations:
            for p, total in zip(periods, totals, strict=True):
                p["total"] = total
        for lineage in lineages:
            counts = counts_by_period(url, {**body, lineage_name: lineage}, field, periods)
            series.append(series_of(lineage, "lineage", counts, totals))

    # Summary: first, last and peak proportion of each series
    lines = [
        (
            f"Shown to the user: frequency over time of {', '.join(s['name'] for s in series)} in {organism} "
            f"({database['name']}), filters: {filters_text(body)}, by {interval} from {date_from} to {date_to}, "
            f"{sum(p['total'] for p in periods):,} sequences with a {field}."
        )
    ]
    for s in series:
        known = [i for i, p in enumerate(s["proportion"]) if p is not None]
        if not known:
            lines.append(f"- {s['name']}: no sequence covers it")
            continue
        peak = max(known, key=lambda i: s["proportion"][i] or 0)
        at = [f"{pct(s['proportion'][i])} in {periods[i]['start'][:7]} (n={s['coverage'][i]:,})" for i in known]
        lines.append(f"- {s['name']}: {at[0]}, peak {at[known.index(peak)]}, last {at[-1]}")
    lines.append("Proportions of sequenced samples, not of infections. A small n gives a wide confidence band.")
    data = OverTimeData(
        organism=organism,
        database=database["name"],
        filters=body,
        date_field=field,
        interval=interval,
        lineage_field=lineage_name,
        periods=periods,
        series=series,
    )
    return text_result("\n".join(lines), data)


# ********** sequences by country **********


@apps.tool(resource_uri="ui://pdn/country-map.html")
def show_lapis_country_map(
    organism: str,
    filters: dict[str, Any] | None = None,
    country_field: str = "",
    latest_version_only: bool = True,
) -> CallToolResult:
    """Show the user a world map of the number of sequences of an organism by country, for the filters given (e.g. a
    date range, a lineage or a mutation), with the counts on hover and a ranked list. Use it for "Where were mpox
    clade Ib sequences collected?" or "Which countries sequenced SARS-CoV-2 JN.1 in 2024?". A count measures
    sequencing effort, not infections.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "mpox".
        filters: As in lapis_aggregate_samples, e.g. {"dateFrom": "2024-01-01", "dateTo": "2024-12-31"} for sars-cov-2,
            {"sampleCollectionDateRangeLowerFrom": "2024-01-01", "clade": "Ib"} for mpox.
        country_field: The country field. Empty picks the sampling country, e.g. country or geoLocCountry.
        latest_version_only: Count each sequence once, skipping older versions and revocations (default True).
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    others = [f for f, t in schema["fields"].items() if t == "string" and "country" in f.lower()]
    field = pick_field(schema, country_field, COUNTRY_FIELDS, "country", others)
    body = query_filters(schema, filters, latest_version_only)
    rows, _ = _lapis_post(f"{url}/sample/aggregated", {**body, "fields": [field]})
    known = [r for r in rows if r[field] and r[field].lower() not in ("missing", "unknown")]
    known.sort(key=lambda r: -r["count"])
    total = sum(r["count"] for r in rows)
    unknown = total - sum(r["count"] for r in known)

    top = ", ".join(f"{r[field]} {r['count']:,}" for r in known[:15])
    text = (
        f"Shown to the user: world map of {total:,} {organism} sequences ({database['name']}) by {field} in "
        f"{len(known)} countries, filters: {filters_text(body)}, {unknown:,} without a country.\n"
        f"Most sequenced: {top or 'none'}\n"
        "A count measures sequencing effort, not infections. The user can click a country to ask about it."
    )
    data = CountryData(
        organism=organism,
        database=database["name"],
        filters=body,
        country_field=field,
        total=total,
        unknown=unknown,
        rows=[CountryCount(country=r[field], count=r["count"]) for r in known],
    )
    return text_result(text, data)


# ********** mutations along the genome **********


@apps.tool(resource_uri="ui://pdn/lollipop.html")
def show_lapis_mutation_lollipop(
    organism: str,
    sequence_type: Literal["amino_acid", "nucleotide"] = "amino_acid",
    filters: dict[str, Any] | None = None,
    min_proportion: float = 0.05,
    gene_or_segment: str = "",
    max_mutations: int = 500,
    latest_version_only: bool = True,
) -> CallToolResult:
    """Show the user a lollipop plot of the mutations along the genome of an organism, in the sequences matching the
    filters: one stick per substitution or deletion at its position, its height the proportion of sequences carrying
    it, colored by gene (or segment). Use it for an overview of the mutation landscape, e.g. "Which spike mutations do
    JN.1 sequences carry?" or "Where are the common mpox mutations in Sierra Leone?".

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "sars-cov-2".
        sequence_type: "amino_acid" (default) for changes within genes, or "nucleotide".
        filters: As in lapis_aggregate_samples, e.g. {"pangoLineage": "JN.1*", "country": "Switzerland"}.
        min_proportion: Drop mutations below this share of the sequences (default 0.05).
        gene_or_segment: Show one gene or segment only, e.g. "S". Empty shows the whole genome.
        max_mutations: Most frequent mutations shown (default 500, max 1000). Past it, LAPIS keeps an arbitrary
            subset of mutations of equal proportion, so prefer one gene or segment, or a higher min_proportion.
        latest_version_only: Count each sequence once, skipping older versions and revocations (default True).
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    if sequence_type == "amino_acid":
        endpoint, kind, lengths = "aminoAcidMutations", "gene", schema["gene_lengths"]
        if not lengths:
            raise ToolError(f"{schema['instance_name']} declares no genes. Use sequence_type 'nucleotide' instead.")
    else:
        endpoint, kind, lengths = "nucleotideMutations", "segment", schema["segment_lengths"]
    if gene_or_segment and gene_or_segment not in lengths:
        close = difflib.get_close_matches(gene_or_segment, list(lengths), n=3, cutoff=0.5)
        hint = f" Close matches: {', '.join(close)}." if close else ""
        names = ", ".join(list(lengths)[:15]) + (", ..." if len(lengths) > 15 else "")
        raise ToolError(
            f"'{gene_or_segment}' is not a {kind} of {schema['instance_name']}.{hint} Its {kind}s: {names}."
        )
    body = query_filters(schema, filters, latest_version_only)
    min_proportion = max(0.0, min(min_proportion, 1.0))
    max_mutations = max(1, min(max_mutations, MAX_LOLLIPOPS))

    # LAPIS cannot filter by gene: with one, fetch all mutations above the threshold and filter here, up to a size
    query = {**body, "minProportion": min_proportion, "fields": LAPIS_MUTATION_FIELDS}
    if not gene_or_segment:
        query.update({"orderBy": [{"field": "proportion", "type": "descending"}], "limit": max_mutations})
    try:
        rows, _ = _lapis_post(
            f"{url}/sample/{endpoint}", query, max_bytes=LAPIS_MAX_FILTER_DOWNLOAD_BYTES if gene_or_segment else None
        )
    except LapisResponseTooLarge:
        raise ToolError(
            f"The mutations above proportion {min_proportion} are too many to filter down to {gene_or_segment}. "
            "Raise min_proportion or narrow the filters."
        ) from None
    total_rows, _ = _lapis_post(f"{url}/sample/aggregated", body)
    total = total_rows[0]["count"]

    # A single-segment genome leaves sequenceName empty
    single = next(iter(lengths)) if len(lengths) == 1 else ""
    mutations = [
        Lollipop(
            mutation=r["mutation"],
            region=r["sequenceName"] or single,
            position=r["position"],
            count=r["count"],
            coverage=r["coverage"],
            proportion=round(r["proportion"], 4),
        )
        for r in rows
        if not gene_or_segment or (r["sequenceName"] or single) == gene_or_segment
    ]
    mutations.sort(key=lambda m: -m["proportion"])
    truncated = len(mutations) > max_mutations or (not gene_or_segment and len(rows) == max_mutations)
    mutations = mutations[:max_mutations]
    order = GENOME_ORDER.get(organism, [])
    names = sorted(lengths, key=lambda n: order.index(n) if n in order else len(order))
    if gene_or_segment:
        names = [gene_or_segment]
    regions = [Region(name=n, length=lengths[n]) for n in names]

    by_region = {r["name"]: [m for m in mutations if m["region"] == r["name"]] for r in regions}
    # The 15 genes or segments with the most mutations, 12 mutations each, to keep the summary short
    ranked = [(name, ms) for name, ms in sorted(by_region.items(), key=lambda x: -len(x[1])) if ms]
    per_region = "; ".join(
        f"{name} ({len(ms)}): " + ", ".join(f"{m['mutation']} {pct(m['proportion'])}" for m in ms[:12])
        for name, ms in ranked[:15]
    )
    if len(ranked) > 15:
        per_region += f"; and {len(ranked) - 15} more {kind}s"
    more = " (more mutations above the threshold were cut)" if truncated else ""
    text = (
        f"Shown to the user: lollipop plot of {len(mutations)} {sequence_type.replace('_', ' ')} mutations{more} at a "
        f"proportion of at least {min_proportion} in {total:,} {organism} sequences ({database['name']}), "
        f"filters: {filters_text(body)}.\nBy {kind}, most frequent first: {per_region or 'none'}\n"
        "Proportions of sequenced samples. The user can click a mutation to ask about it."
    )
    data = LollipopData(
        organism=organism,
        database=database["name"],
        filters=body,
        sequence_type=sequence_type,
        min_proportion=min_proportion,
        total=total,
        regions=regions,
        mutations=mutations,
        truncated=truncated,
    )
    return text_result(text, data)


# Charts drawn in plain SVG, except the map: d3 and topojson from the CDN, which also serves the world map fetched
apps.add_html_resource("ui://pdn/over-time.html", widget_html("pdn-over-time.html"), title="LAPIS mutations over time")
apps.add_html_resource(
    "ui://pdn/country-map.html",
    widget_html("pdn-country-map.html"),
    title="LAPIS sequences by country",
    csp=ResourceCsp(resource_domains=[CDN], connect_domains=[CDN]),
)
apps.add_html_resource(
    "ui://pdn/lollipop.html", widget_html("pdn-lollipop.html"), title="LAPIS mutations along the genome"
)
