"""GEO tools showing MCP Apps widgets: series explorer with its samples and supplementary files.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
"""

from collections import Counter
from typing import TypedDict

from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult

from .apps_common import apps, text_result, widget_html

GEO_QUERY = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi"
# Sample metadata is fetched in one SOFT request, about 3 KB and 35 ms per sample: skipped for bigger series
MAX_SOFT_SAMPLES = 400


# Data sent to the widget in `structuredContent`, as read by `widgets/geo-series.html`
class GeoSample(TypedDict):
    accession: str
    title: str
    source: str | None
    organism: str | None
    characteristics: dict[str, str]
    """e.g. {"strain": "K-12", "treatment": "control"}, keys of the 2nd channel prefixed with `ch2 `"""
    description: str | None
    sra: str | None
    """SRA experiment URL"""
    files: list[str]
    """Sample level supplementary file URLs"""


class GeoFile(TypedDict):
    name: str
    url: str
    size: str | None
    modified: str | None
    directory: bool


class GeoSeriesData(TypedDict):
    accession: str
    title: str
    summary: str
    design: str | None
    types: list[str]
    organism: str
    platforms: list[dict[str, str]]
    """[{"accession": "GPL24659", "title": "Illumina HiSeq 4000 (...)"}]"""
    submitted: str | None
    public: str | None
    updated: str | None
    contributors: list[str]
    pubmed: list[str]
    bioproject: str | None
    subseries: list[str]
    superseries: list[str]
    url: str
    sample_count: int
    samples: list[GeoSample]
    samples_note: str | None
    files: list[GeoFile]
    files_url: str | None
    files_note: str | None


def parse_soft(text: str) -> list[tuple[str, dict[str, list[str]]]]:
    """SOFT text as (entity accession, {field: values}) blocks, fields without their `!Series_` like prefix"""
    blocks: list[tuple[str, dict[str, list[str]]]] = []
    for line in text.splitlines():
        if line.startswith("^"):
            blocks.append((line.partition("=")[2].strip(), {}))
        elif line.startswith("!") and blocks and " = " in line:
            key, _, value = line[1:].partition(" = ")
            blocks[-1][1].setdefault(key.split("_", 1)[-1], []).append(value.strip())
    return blocks


def fetch_soft(accession: str, target: str) -> list[tuple[str, dict[str, list[str]]]]:
    """Brief SOFT of a record (`self`) or of all its samples (`gsm`), metadata without data tables"""
    from .geo import _get

    params = {"acc": accession, "targ": target, "form": "text", "view": "brief"}
    # No charset in the `geo/text` content type, the SOFT text is UTF-8
    return parse_soft(_get(GEO_QUERY, params).content.decode("utf-8", "replace"))


def https(url: str) -> str:
    return "https://" + url[len("ftp://") :] if url.startswith("ftp://") else url


def sample_of(accession: str, f: dict[str, list[str]]) -> GeoSample:
    characteristics: dict[str, str] = {}
    for channel in ("ch1", "ch2"):
        for c in f.get(f"characteristics_{channel}", []):
            key, sep, value = c.partition(":")
            key = key.strip() if sep else "characteristic"
            key = f"ch2 {key}" if channel == "ch2" else key
            characteristics[key] = "; ".join(filter(None, [characteristics.get(key), (value if sep else c).strip()]))
    relations = f.get("relation", [])
    return GeoSample(
        accession=accession,
        title=f.get("title", [""])[0],
        source=next(iter(f.get("source_name_ch1", [])), None),
        organism=next(iter(f.get("organism_ch1", [])), None),
        characteristics=characteristics,
        description=" ".join(f.get("description", [])) or None,
        sra=next((r.split(": ", 1)[1] for r in relations if r.startswith("SRA: ")), None),
        files=[https(v) for k, vs in f.items() if k.startswith("supplementary_file") for v in vs if v != "NONE"],
    )


def first(fields: dict[str, list[str]], key: str) -> str | None:
    return next(iter(fields.get(key, [])), None)


def summarize_samples(samples: list[GeoSample]) -> list[str]:
    """Characteristics with their values counts, and the first samples"""
    keys = list(dict.fromkeys(k for s in samples for k in s["characteristics"]))
    lines = ["Sample characteristics:"] if keys else []
    for key in keys:
        values = Counter(s["characteristics"].get(key, "-") for s in samples)
        top = ", ".join(f"{v} ({n})" for v, n in values.most_common(12))
        lines.append(f"- {key}: {top}{f', +{len(values) - 12} more' if len(values) > 12 else ''}")
    listed = "; ".join(f"{s['accession']} {s['title']}" for s in samples[:60])
    lines.append(f"Samples: {listed}{f'; +{len(samples) - 60} more' if len(samples) > 60 else ''}")
    return lines


@apps.tool(resource_uri="ui://geo/series.html")
def show_geo_series(accession: str) -> CallToolResult:
    """Show one GEO Series (GSE accession, e.g. GSE309890) to the user in an interactive explorer: title, summary,
    overall design, organism, platform, dates, a sortable and filterable table of its samples (GSM) with their
    characteristics (strain, treatment, time...), and the supplementary files holding the processed expression values
    with sizes and download links. The user can select samples and send them back to you.
    Use it when the user wants to see or explore a study, its samples or its files, after finding it with geo_search"""
    from .geo import geo_series, parse_accession  # imported here: geo.py imports the server, which imports this module

    prefix, number = parse_accession(accession)
    if prefix != "GSE":
        raise ToolError(f"{accession!r} is not a GEO Series, give a GSE accession (e.g. GSE309890), use geo_series")
    gse = f"GSE{number}"

    # esummary and the FTP listing of the supplementary files, then the SOFT metadata of the series and samples
    res = geo_series(gse)
    record = res["record"]
    series = dict(fetch_soft(gse, "self")).get(gse, {})
    sample_count = record.get("sample_count") or len(record.get("samples", []))
    samples: list[GeoSample] = []
    samples_note = record.get("samples_note")
    if sample_count <= MAX_SOFT_SAMPLES:
        samples = [sample_of(acc, f) for acc, f in fetch_soft(gse, "gsm") if acc.startswith("GSM")]
    if not samples:
        # Too many samples to fetch their characteristics: titles from esummary only
        samples = [
            GeoSample(
                accession=s["accession"],
                title=s["title"],
                source=None,
                organism=None,
                characteristics={},
                description=None,
                sra=None,
                files=[],
            )
            for s in record.get("samples", [])
        ]
        if sample_count > MAX_SOFT_SAMPLES:
            samples_note = (
                f"Sample titles only: characteristics are loaded for series of up to {MAX_SOFT_SAMPLES} samples"
            )
    samples.sort(key=lambda s: s["accession"])

    files = [
        GeoFile(
            name=f["name"],
            url=f["url"],
            size=f.get("size"),
            modified=f.get("last_modified"),
            directory=f["is_directory"],
        )
        for f in res.get("supplementary_files", [])
    ]

    def relations(kind: str) -> list[str]:
        return [r.split(": ", 1)[1] for r in series.get("relation", []) if r.startswith(f"{kind}: ")]

    platforms = [p.split(" ", 1)[0] for p in series.get("platform_id", [])] or [record.get("platform", "")]
    data = GeoSeriesData(
        accession=gse,
        title=record["title"],
        summary=record["summary"],
        design=" ".join(series.get("overall_design", [])) or None,
        types=series.get("type", []) or [record.get("experiment_type", "")],
        organism=record.get("taxon", ""),
        platforms=[
            {"accession": p, "title": record.get("platform_title", "") if len(platforms) == 1 else ""}
            for p in platforms
            if p
        ],
        submitted=first(series, "submission_date"),
        public=(first(series, "status") or "").removeprefix("Public on ") or record.get("date_public"),
        updated=first(series, "last_update_date"),
        contributors=[" ".join(filter(None, c.split(","))) for c in series.get("contributor", [])],
        pubmed=record.get("pubmed_ids", []),
        bioproject=record.get("bioproject"),
        subseries=relations("SuperSeries of"),
        superseries=relations("SubSeries of"),
        url=res["geo_url"],
        sample_count=sample_count,
        samples=samples,
        samples_note=samples_note,
        files=files,
        files_url=res.get("supplementary_directory_url"),
        files_note=None if files else res.get("supplementary_files_note"),
    )

    # Summary for the model: metadata, samples characteristics and files
    file_list = "; ".join(f"{f['name']} ({f['size'] or ('directory' if f['directory'] else '?')})" for f in files)
    lines = [
        f"Shown to the user: GEO Series {gse}, {data['title']}",
        f"Organism: {data['organism']} · Type: {', '.join(data['types'])} · Platform: {', '.join(platforms)}",
        f"Public: {data['public']} · {sample_count} samples · PubMed: {', '.join(data['pubmed']) or 'none'}",
        f"Design: {data['design'] or '-'}",
        *([f"SuperSeries of: {', '.join(data['subseries'])}"] if data["subseries"] else []),
        *([f"SubSeries of: {', '.join(data['superseries'])}"] if data["superseries"] else []),
        *summarize_samples(samples),
        f"Supplementary files (the processed values): {file_list or res.get('supplementary_files_note', 'none')}",
        "The user can filter, sort and select samples in the table, the selection is sent to you.",
    ]
    if samples_note:
        lines.insert(3, samples_note)
    return text_result("\n".join(lines), data)


apps.add_html_resource("ui://geo/series.html", widget_html("geo-series.html"), title="GEO series explorer")
