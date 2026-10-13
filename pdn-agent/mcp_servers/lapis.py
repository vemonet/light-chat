"""LAPIS helpers shared by the PDN tools (`pdn.py`) and the PDN widgets (`pdn_apps.py`)"""

import difflib
import json
import time
from datetime import date, timedelta
from typing import Any

import requests
from mcp.server.mcpserver.exceptions import ToolError

# LAPIS  (Pathoplexus, GenSpectrum Loculus, CoV-Spectrum open)
#
# LAPIS serves one URL per organism, and each organism declares its own
# metadata fields. The tools read those fields at runtime, so no field name
# is hard-coded here.


# ********** shared by the LAPIS tools **********

LAPIS_HEADERS = {
    "Accept": "application/json",
    "User-Agent": (
        "federated-data-ecosystem-assistant "
        "(+https://github.com/NIAID-BRC-Codeathons/federated-data-ecosystem-assistant)"
    ),
}

# An organism schema changes rarely, so refetch it after an hour.
LAPIS_SCHEMA_TTL_SECONDS = 3600

# No LAPIS endpoint lists the organisms. These names come from each
# database's API documentation page, checked on 2026-09-16.
LAPIS_DATABASES: dict[str, dict[str, Any]] = {
    "pathoplexus": {
        "name": "Pathoplexus",
        "description": "Human viral pathogens",
        "organism_url": "https://lapis.pathoplexus.org/{organism}",
        "record_url": "https://pathoplexus.org/seq/{accession}",
        "organisms": [
            "andv",
            "cchf",
            "dengue",
            "ebola-bdbv",
            "ebola-sudan",
            "ebola-zaire",
            "hmpv",
            "marburg",
            "measles",
            "mpox",
            "rsv-a",
            "rsv-b",
            "west-nile",
            "yellow-fever",
            "zika",
        ],
    },
    "genspectrum": {
        "name": "GenSpectrum Loculus",
        "description": "Influenza lineages and dengue serotypes",
        "organism_url": "https://api.loculus.genspectrum.org/{organism}",
        "record_url": "https://loculus.genspectrum.org/seq/{accession}",
        "organisms": [
            "b-victoria",
            "denv1",
            "denv2",
            "denv3",
            "denv4",
            "h1n1pdm",
            "h3n2",
            "h5n1",
            "influenza-a",
            "influenza-b",
        ],
    },
    "cov-spectrum": {
        "name": "CoV-Spectrum open",
        "description": "Open SARS-CoV-2 data from Nextstrain",
        # A single dataset, so the URL takes no organism name.
        "organism_url": "https://lapis.cov-spectrum.org/open/v2",
        "record_url": None,
        "organisms": ["sars-cov-2"],
    },
}

_lapis_schema_cache: dict[str, tuple[float, dict]] = {}

# Filter keys that LAPIS accepts on every organism, beside the field names.
LAPIS_QUERY_KEYS = {
    "advancedQuery",
    "nucleotideMutations",
    "aminoAcidMutations",
    "nucleotideInsertions",
    "aminoAcidInsertions",
}

# Field types that take a "From" or "To" range filter.
LAPIS_RANGE_TYPES = {"int", "float", "date"}

# Pathoplexus records carry these fields. A redistributor must keep them with
# the data, so every record query adds them wherever the schema has them.
LAPIS_TERMS_FIELDS = ["dataUseTerms", "dataUseTermsRestrictedUntil", "dataUseTermsUrl"]

# Pathoplexus states these duties on its terms of use pages. A redistributor
# must pass them on, so a record tool returns them beside the records.
LAPIS_TERMS_OPEN = (
    "Open records carry no use restriction. When you share them onward, keep "
    "the data use terms with them, and link each record to its page. "
    "Acknowledging the people who generated the data is expected: in a "
    "manuscript, create a Pathoplexus SeqSet and cite its DOI."
)

LAPIS_TERMS_RESTRICTED = (
    "The submitters restrict these records until the dates given. Keep the "
    "data use terms with the records, and link each record to its page when "
    "you present it publicly. In a manuscript, create a Pathoplexus SeqSet "
    "and cite its DOI. For any sequence that is central to the analysis, "
    "name the submitters as authors, or get a written authorship waiver. Add "
    "no further access restriction when you pass the records on."
)


def _lapis_organism(organism: str) -> tuple[dict, str]:
    """Return the database and the LAPIS URL for an organism name."""
    for database in LAPIS_DATABASES.values():
        if organism in database["organisms"]:
            return database, database["organism_url"].format(organism=organism)
    known = [o for d in LAPIS_DATABASES.values() for o in d["organisms"]]
    close = difflib.get_close_matches(organism, known, n=3)
    hint = f" Close matches: {', '.join(close)}." if close else ""
    raise ToolError(f"Unknown organism '{organism}'.{hint} Call lapis_list_organisms for the full list.")


def _lapis_get(url: str) -> dict:
    resp = requests.get(url, headers=LAPIS_HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _lapis_schema(organism: str) -> dict:
    """Fetch the fields, segments, and genes for an organism, with a cache."""
    cached = _lapis_schema_cache.get(organism)
    if cached and time.monotonic() - cached[0] < LAPIS_SCHEMA_TTL_SECONDS:
        return cached[1]
    _, url = _lapis_organism(organism)
    config = _lapis_get(f"{url}/sample/databaseConfig")["schema"]
    reference = _lapis_get(f"{url}/sample/referenceGenome")
    schema = {
        "instance_name": config["instanceName"],
        "primary_key": config["primaryKey"],
        "fields": {m["name"]: m["type"] for m in config["metadata"]},
        "phylo_tree_fields": [m["name"] for m in config["metadata"] if m.get("isPhyloTreeField")],
        # A lineage field holds a hierarchy, so a filter on it can match a
        # whole clade with a "*" suffix.
        "lineage_fields": [m["name"] for m in config["metadata"] if m.get("generateLineageIndex")],
        # The reference genome carries full sequences. Keep only the names.
        "segments": [s["name"] for s in reference["nucleotideSequences"]],
        "genes": [g["name"] for g in reference["genes"]],
        # Lengths place the mutations along the genome in the lollipop widget
        "segment_lengths": {s["name"]: len(s["sequence"]) for s in reference["nucleotideSequences"]},
        "gene_lengths": {g["name"]: len(g["sequence"]) for g in reference["genes"]},
    }
    _lapis_schema_cache[organism] = (time.monotonic(), schema)
    return schema


class LapisResponseTooLarge(Exception):
    """A LAPIS response passed the size limit that the caller set."""


def _lapis_post(url: str, body: dict, max_bytes: int | None = None) -> tuple[Any, str | None]:
    """POST a LAPIS query. Return the data rows and the LAPIS data version.

    A LAPIS error becomes a short tool error. With max_bytes, the read stops
    as soon as the response passes that size. The sequence endpoints answer
    with a bare list, and every other endpoint wraps its rows in "data", an
    object for the component endpoints.
    """
    with requests.post(url, json=body, headers=LAPIS_HEADERS, timeout=60, stream=True) as resp:
        if resp.status_code >= 400:
            try:
                detail = resp.json()["error"]["detail"]
            except (ValueError, KeyError, TypeError):
                detail = resp.text
            raise ToolError(f"LAPIS returned HTTP {resp.status_code}: {detail[:500]}")
        content = bytearray()
        for chunk in resp.iter_content(chunk_size=1 << 16):
            content += chunk
            if max_bytes is not None and len(content) > max_bytes:
                raise LapisResponseTooLarge(max_bytes)
        payload = json.loads(content)
        rows = payload if isinstance(payload, list) else payload["data"]
        return rows, resp.headers.get("lapis-data-version")


def _lapis_unknown_field(schema: dict, name: str) -> ToolError:
    names = list(schema["fields"])
    close = difflib.get_close_matches(name, names, n=3, cutoff=0.6)
    close += [n for n in names if name.lower() in n.lower() and n not in close]
    hint = f" Close matches: {', '.join(close[:5])}." if close else ""
    return ToolError(
        f"'{name}' is not a field of {schema['instance_name']}.{hint} "
        "Call lapis_describe_organism with field_search to find field names."
    )


def _lapis_check_filters(schema: dict, filters: dict) -> None:
    """Reject a filter key that the organism does not declare.

    LAPIS answers an unknown key with a list of every valid key, often more
    than 400. A short error with close matches serves the agent better.
    """
    fields = schema["fields"]
    for key in filters:
        if key in fields or key in LAPIS_QUERY_KEYS:
            continue
        for suffix in (".regex", ".isNull", "From", "To"):
            field = key.removesuffix(suffix)
            if field != key and field in fields:
                break
        else:
            raise _lapis_unknown_field(schema, key)
        field_type = fields[field]
        if suffix in ("From", "To") and field_type not in LAPIS_RANGE_TYPES:
            date_fields = [f for f, t in fields.items() if t == "date"]
            raise ToolError(
                f"'{key}' does not exist. '{field}' has type {field_type}, and "
                "only int, float, and date fields take From or To. "
                f"Date fields: {', '.join(date_fields)}."
            )
        if suffix == ".regex" and field_type != "string":
            raise ToolError(
                f"'{key}' does not exist. '{field}' has type {field_type}, and only string fields take .regex."
            )


def _lapis_version_filter(schema: dict, filters: dict, latest_version_only: bool) -> str | None:
    """Add the latest-version filters to filters in place. Return a note on them.

    Loculus keeps every version of a sequence, and a revocation stays as its
    own record. Without these filters, one sequence can count several times.
    """
    fields = schema["fields"]
    if "versionStatus" not in fields:
        return None
    if latest_version_only:
        filters.setdefault("versionStatus", "LATEST_VERSION")
        if "isRevocation" in fields:
            filters.setdefault("isRevocation", False)
    if filters.get("versionStatus") == "LATEST_VERSION" and filters.get("isRevocation") is False:
        return "Counts only the latest version of each sequence and skips revocations, so each sequence counts once."
    return "Includes older versions or revocations, so one sequence can count more than once."


def _lapis_data_use_terms(database: dict, schema: dict, rows: list[dict]) -> dict | None:
    """Describe the data use terms of the rows. None when the database declares none.

    Pathoplexus asks a redistributor to pass the terms on and to link each
    record back, for open records as well as restricted ones.
    """
    if "dataUseTerms" not in schema["fields"] or not database["record_url"]:
        return None
    key = schema["primary_key"]
    records = []
    for row in rows:
        terms = row.get("dataUseTerms")
        if terms is None:
            continue
        record = {
            "accession": row[key],
            "terms": terms,
            "record_url": database["record_url"].format(accession=row[key]),
        }
        if terms == "RESTRICTED":
            record["restricted_until"] = row.get("dataUseTermsRestrictedUntil")
        records.append(record)
    if not records:
        return None
    obligations = []
    if any(r["terms"] != "RESTRICTED" for r in records):
        obligations.append(LAPIS_TERMS_OPEN)
    if any(r["terms"] == "RESTRICTED" for r in records):
        obligations.append(LAPIS_TERMS_RESTRICTED)
    return {
        "records": records,
        "terms_urls": sorted({r["dataUseTermsUrl"] for r in rows if r.get("dataUseTermsUrl")}),
        "obligations": obligations,
    }


# The mutation name already encodes mutationFrom, mutationTo, and position,
# so a mutation query asks LAPIS for these columns only.
LAPIS_MUTATION_FIELDS = [
    "mutation",
    "sequenceName",
    "position",
    "count",
    "coverage",
    "proportion",
]

# LAPIS cannot filter mutations by gene or segment, so a gene or segment
# filter downloads every mutation above the threshold. At threshold 0 that
# reached 13 MB for dengue nucleotides, so the read stops past this size.
LAPIS_MAX_FILTER_DOWNLOAD_BYTES = 5_000_000


# ********** mutations over time **********

LAPIS_MAX_PERIODS = 60

# LAPIS counts over a date field, and the field must hold a date. Pathoplexus
# stores sampleCollectionDate as text, so it keeps a date copy beside it.
LAPIS_PREFERRED_DATE_FIELDS = ["date", "sampleCollectionDateRangeLower"]


def _lapis_date_field(schema: dict, date_field: str) -> str:
    """Return the date field to count over, or explain what the organism has."""
    dates = [f for f, t in schema["fields"].items() if t == "date"]
    if not dates:
        raise ToolError(f"{schema['instance_name']} declares no date field to count over.")
    if date_field:
        if date_field not in dates:
            raise ToolError(
                f"'{date_field}' is not a date field of {schema['instance_name']}. Its date fields: {', '.join(dates)}."
            )
        return date_field
    for preferred in LAPIS_PREFERRED_DATE_FIELDS:
        if preferred in dates:
            return preferred
    return dates[0]


def _lapis_date_ranges(date_from: str, date_to: str, interval: str) -> list[dict]:
    """Cut a span into periods. The first starts on date_from, the rest on a boundary."""
    try:
        start, end = date.fromisoformat(date_from), date.fromisoformat(date_to)
    except ValueError:
        raise ToolError("date_from and date_to take an ISO date, e.g. '2025-01-01'.") from None
    if end < start:
        raise ToolError("date_to falls before date_from.")
    step = {"month": 1, "quarter": 3, "year": 12}[interval]
    ranges, cursor = [], start
    while cursor <= end:
        month = cursor.month - 1 + step
        following = date(cursor.year + month // 12, month % 12 + 1, 1)
        ranges.append(
            {
                "dateFrom": cursor.isoformat(),
                "dateTo": min(following - timedelta(days=1), end).isoformat(),
            }
        )
        if len(ranges) > LAPIS_MAX_PERIODS:
            raise ToolError(
                f"That span holds over {LAPIS_MAX_PERIODS} periods of one "
                f"{interval}. Use a wider interval, or a shorter span."
            )
        cursor = following
    return ranges
