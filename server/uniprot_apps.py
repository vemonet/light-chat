"""UniProt tools showing MCP Apps widgets: sequence features, 3D structure with features, and a search results table.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
Widgets are in `widgets/`, local scripts and stylesheets they reference are inlined when served.
"""

import asyncio
import re
from collections import Counter
from pathlib import Path
from typing import Any

import httpx2
from mcp.server.apps import Apps, ResourceCsp
from mcp_types import CallToolResult, TextContent

UNIPROT_API = "https://rest.uniprot.org/uniprotkb"
ALPHAFOLD_API = "https://alphafold.ebi.ac.uk/api/prediction"
WIDGETS = Path(__file__).parent / "widgets"
CDN = "https://cdn.jsdelivr.net"
# UniProt queries not cached yet can take tens of seconds, and the API sometimes answers 503
TIMEOUT = 60
ATTEMPTS = 3

# Feature types shown, grouped in categories like ProtVista tracks
CATEGORIES = {
    "Domains & regions": [
        "Domain",
        "Repeat",
        "Region",
        "Motif",
        "Zinc finger",
        "DNA binding",
        "Coiled coil",
        "Compositional bias",
    ],
    "Sites": ["Active site", "Binding site", "Site"],
    "PTMs": ["Modified residue", "Glycosylation", "Lipidation", "Disulfide bond", "Cross-link"],
    "Processing": ["Signal", "Transit peptide", "Propeptide", "Chain", "Peptide", "Initiator methionine"],
    "Topology": ["Topological domain", "Transmembrane", "Intramembrane"],
    "Secondary structure": ["Helix", "Beta strand", "Turn"],
    "Variants": ["Natural variant", "Mutagenesis"],
}
CATEGORY = {t: c for c, types in CATEGORIES.items() for t in types}

apps = Apps()


def text_result(text: str, data: dict[str, Any]) -> CallToolResult:
    """Summary for the model, full data for the widget"""
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=data)


def http_client() -> httpx2.AsyncClient:
    return httpx2.AsyncClient(timeout=TIMEOUT)


async def get(client: httpx2.AsyncClient, url: str, params: dict[str, Any] | None = None) -> httpx2.Response:
    """GET retried on timeouts and server errors, which are transient on the UniProt and AlphaFold APIs"""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            res = await client.get(url, params=params)
            if res.status_code < 500 or attempt == ATTEMPTS:
                return res
        except httpx2.TransportError:
            if attempt == ATTEMPTS:
                raise RuntimeError(f"{url} did not answer after {ATTEMPTS} attempts, try again later") from None
        await asyncio.sleep(attempt)
    raise AssertionError("unreachable")


async def fetch_entry(client: httpx2.AsyncClient, accession: str) -> dict[str, Any]:
    res = await get(client, f"{UNIPROT_API}/{accession.strip()}.json")
    if res.status_code in (400, 404):
        raise ValueError(f"UniProtKB entry {accession!r} not found")
    res.raise_for_status()
    return res.json()


def protein_name(e: dict[str, Any]) -> str | None:
    desc = e.get("proteinDescription", {})
    name = desc.get("recommendedName") or next(iter(desc.get("submissionNames") or []), {})
    return name.get("fullName", {}).get("value")


def entry_info(e: dict[str, Any]) -> dict[str, Any]:
    genes = [g["geneName"]["value"] for g in e.get("genes", []) if "geneName" in g]
    return {
        "accession": e["primaryAccession"],
        "id": e.get("uniProtkbId"),
        "name": protein_name(e),
        "gene": next(iter(genes), None),
        "organism": e.get("organism", {}).get("scientificName"),
        "length": e.get("sequence", {}).get("length"),
        "sequence": e.get("sequence", {}).get("value"),
    }


def features_of(e: dict[str, Any]) -> list[dict[str, Any]]:
    """Features with known positions, for the types shown in tracks"""
    features = []
    for f in e.get("features", []):
        start, end = f["location"]["start"].get("value"), f["location"]["end"].get("value")
        if f["type"] not in CATEGORY or start is None or end is None:
            continue
        alt = f.get("alternativeSequence") or {}
        # Amino acid change of variants and mutagenesis, e.g. E17K
        change = None
        if alt.get("originalSequence"):
            change = f"{alt['originalSequence']}{start}{'/'.join(alt.get('alternativeSequences') or []) or 'del'}"
        refs = [f"{ev['source']}:{ev['id']}" for ev in f.get("evidences", []) if ev.get("source") and ev.get("id")]
        features.append(
            {
                "type": f["type"],
                "category": CATEGORY[f["type"]],
                "start": start,
                "end": end,
                "description": f.get("description") or (f.get("ligand") or {}).get("name") or "",
                "change": change,
                "refs": refs[:5],
            }
        )
    return features


def feature_label(f: dict[str, Any], max_len: int = 60) -> str:
    pos = str(f["start"]) if f["start"] == f["end"] else f"{f['start']}-{f['end']}"
    desc = f["description"].split(";")[0]
    desc = desc if len(desc) <= max_len else desc[: max_len - 3] + "..."
    return " ".join(x for x in [f["change"] or pos, desc] if x)


def features_text(features: list[dict[str, Any]], per_type: int = 25) -> str:
    """Features listed by type, a few per type"""
    by_type: dict[str, list[dict[str, Any]]] = {}
    for f in features:
        by_type.setdefault(f["type"], []).append(f)
    lines = []
    for t, fs in by_type.items():
        more = f"; +{len(fs) - per_type} more" if len(fs) > per_type else ""
        lines.append(f"- {t} ({len(fs)}): " + "; ".join(feature_label(f) for f in fs[:per_type]) + more)
    return "\n".join(lines)


def entry_title(info: dict[str, Any]) -> str:
    return f"{info['accession']} ({info['id']}, {info['name']}, {info['organism']}, {info['length']} aa)"


@apps.tool(resource_uri="ui://uniprot/features.html")
async def show_protein_features(accession: str) -> CallToolResult:
    """Show the sequence features of a UniProtKB entry (e.g. P31749) to the user in an interactive track viewer,
    zoomable along the sequence: domains, sites, PTMs, signal peptides, topology, secondary structure and variants"""
    async with http_client() as client:
        e = await fetch_entry(client, accession)
    info, features = entry_info(e), features_of(e)
    text = f"Shown to the user: {len(features)} features of {entry_title(info)}\n{features_text(features)}"
    return text_result(text, {**info, "features": features})


async def fetch_alphafold(client: httpx2.AsyncClient, accession: str) -> dict[str, Any] | None:
    """AlphaFold DB model of the full sequence, if any"""
    res = await get(client, f"{ALPHAFOLD_API}/{accession}")
    if res.status_code != 200:
        return None
    model = next((m for m in res.json() if m.get("uniprotAccession") == accession), None)
    if not model:
        return None
    return {
        "entryId": model["modelEntityId"],
        "url": model["bcifUrl"],
        "plddtUrl": model.get("plddtDocUrl"),
        "meanPlddt": model.get("globalMetricValue"),
        "sequenceStart": model.get("sequenceStart", 1),
        "fractions": {
            "very high": model.get("fractionPlddtVeryHigh"),
            "confident": model.get("fractionPlddtConfident"),
            "low": model.get("fractionPlddtLow"),
            "very low": model.get("fractionPlddtVeryLow"),
        },
    }


def pdb_entries(e: dict[str, Any]) -> list[dict[str, Any]]:
    """PDB cross-references of the entry, best resolution first"""
    entries = []
    for x in e.get("uniProtKBCrossReferences", []):
        if x["database"] != "PDB":
            continue
        props = {p["key"]: p["value"] for p in x.get("properties", [])}
        resolution = re.match(r"[\d.]+", props.get("Resolution", ""))
        entries.append(
            {
                "id": x["id"].lower(),
                "method": props.get("Method"),
                "resolution": float(resolution.group()) if resolution else None,
                "chains": props.get("Chains"),
            }
        )
    return sorted(entries, key=lambda p: p["resolution"] or 99)


@apps.tool(resource_uri="ui://uniprot/structure.html")
async def show_protein_structure(
    accession: str, pdb_id: str | None = None, positions: list[int] | None = None
) -> CallToolResult:
    """Show the 3D structure of a UniProtKB entry to the user in Mol*: the AlphaFold model colored by pLDDT
    confidence, or a PDB entry with `pdb_id`. Its features and variants are listed next to it, clicking one highlights
    its residues. `positions` are UniProt residue numbers highlighted first, e.g. the position of a mutation"""
    async with http_client() as client:
        e, alphafold = await asyncio.gather(fetch_entry(client, accession), fetch_alphafold(client, accession))
        # Confidence of the highlighted residues
        plddt: dict[int, float] = {}
        if positions and alphafold and alphafold["plddtUrl"]:
            res = await get(client, alphafold["plddtUrl"])
            if res.status_code == 200:
                doc = res.json()
                plddt = dict(zip(doc["residueNumber"], doc["confidenceScore"], strict=False))
    info, features, pdb = entry_info(e), features_of(e), pdb_entries(e)
    source = pdb_id.lower() if pdb_id else "alphafold" if alphafold else pdb[0]["id"] if pdb else None
    if not source:
        raise ValueError(f"No AlphaFold model or PDB entry for {accession}")
    positions = positions or []
    # PDB entries the user can switch to in the widget
    data = {
        **info,
        "features": features,
        "alphafold": alphafold,
        "pdb": pdb[:100],
        "source": source,
        "positions": positions,
    }

    # Summary: structure shown, confidence, features at the highlighted positions, other structures
    lines = [f"Shown to the user: 3D structure of {entry_title(info)}"]
    if source == "alphafold" and alphafold:
        fractions = ", ".join(f"{round(v * 100)}% {k}" for k, v in alphafold["fractions"].items() if v is not None)
        lines.append(f"AlphaFold model {alphafold['entryId']}, mean pLDDT {alphafold['meanPlddt']} ({fractions})")
    else:
        lines.append(f"PDB entry {source.upper()}, residues numbered as in UniProt")
    for p in positions:
        at = [
            feature_label(f) + f" [{f['type']}]"
            for f in features
            if f["start"] <= p <= f["end"] and f["type"] != "Chain"
        ]
        conf = f", pLDDT {plddt[p]}" if p in plddt else ""
        lines.append(f"Residue {p} highlighted{conf}, in: {'; '.join(at) or 'no annotated feature'}")
    if pdb:
        best = ", ".join(
            f"{p['id'].upper()} ({p['method']}, {p['resolution'] or '-'} A, {p['chains']})" for p in pdb[:15]
        )
        lines.append(f"PDB entries ({len(pdb)}): {best}")
    lines.append("The user can click the features listed in the widget to highlight their residues.")
    return text_result("\n".join(lines), data)


def search_row(e: dict[str, Any]) -> dict[str, Any]:
    return {
        "accession": e["primaryAccession"],
        "id": e.get("uniProtkbId"),
        "name": protein_name(e),
        "gene": next((g["geneName"]["value"] for g in e.get("genes", []) if "geneName" in g), None),
        "organism": e.get("organism", {}).get("scientificName"),
        "taxId": e.get("organism", {}).get("taxonId"),
        "reviewed": "Swiss-Prot" in e.get("entryType", ""),
        "score": int(e.get("annotationScore") or 0),
        "length": e.get("sequence", {}).get("length"),
    }


def counts(values: list[Any], top: int = 8) -> str:
    return ", ".join(f"{k}: {n}" for k, n in Counter(values).most_common(top))


@apps.tool(resource_uri="ui://uniprot/table.html")
async def search_proteins_table(query: str, max_rows: int = 1000) -> CallToolResult:
    """Search UniProtKB with its query syntax (e.g. `kinase AND organism_id:9606 AND cc_disease:*`, `reviewed:true`)
    and show all results to the user in a sortable table, with facets for reviewed status, organism and annotation
    score. Only a summary is returned: the user can select rows in the table and send them back to you"""
    params = {
        "query": query,
        "size": min(500, max_rows),
        "fields": "accession,id,protein_name,gene_primary,organism_name,reviewed,annotation_score,length",
    }
    rows: list[dict[str, Any]] = []
    async with http_client() as client:
        res = await get(client, f"{UNIPROT_API}/search", params)
        if res.status_code == 400:
            raise ValueError(f"Invalid query: {', '.join(res.json().get('messages', []))}")
        res.raise_for_status()
        total = int(res.headers.get("x-total-results", 0))
        rows += [search_row(e) for e in res.json()["results"]]
        # Next pages, with the cursor in the `Link` header
        while len(rows) < max_rows and "next" in res.links:
            res = await get(client, res.links["next"]["url"])
            res.raise_for_status()
            rows += [search_row(e) for e in res.json()["results"]]
    rows = rows[:max_rows]

    reviewed = sum(r["reviewed"] for r in rows)
    first = "; ".join(f"{r['accession']} {r['gene'] or r['id']} {r['name']}" for r in rows[:10])
    text = (
        f"Shown to the user in a table: {len(rows)} of {total} UniProtKB entries matching `{query}`.\n"
        f"Reviewed (Swiss-Prot): {reviewed}, unreviewed (TrEMBL): {len(rows) - reviewed}\n"
        f"Organisms: {counts([r['organism'] for r in rows])}\n"
        f"Annotation scores: {counts([r['score'] for r in rows], 5)}\n"
        f"First rows: {first}\n"
        "The user can filter, sort and select rows in the table, the selection is sent to you."
    )
    return text_result(text, {"query": query, "total": total, "rows": rows})


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


apps.add_html_resource(
    "ui://uniprot/features.html",
    widget_html("features.html"),
    title="UniProt sequence features",
    csp=ResourceCsp(resource_domains=[CDN]),
)
apps.add_html_resource(
    "ui://uniprot/structure.html",
    widget_html("structure.html"),
    title="UniProt structure and features",
    csp=ResourceCsp(
        resource_domains=[CDN, "https://alphafold.ebi.ac.uk"],
        connect_domains=["https://alphafold.ebi.ac.uk", "https://www.ebi.ac.uk"],
    ),
)
apps.add_html_resource("ui://uniprot/table.html", widget_html("table.html"), title="UniProt search results")
