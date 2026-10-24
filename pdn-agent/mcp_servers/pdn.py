"""Pathogen Data Network (PDN) MCP tools

MCP tools over Pathogen Data Network resources:
    - LAPIS - pathogen sequences and metadata from Pathoplexus,
      GenSpectrum Loculus, and CoV-Spectrum open
and tools showing interactive widgets (MCP Apps) from `pdn_apps.py`.
The LAPIS helpers shared by both are in `lapis.py`.
"""

import difflib
from typing import Any, Literal

from mcp.server.mcpserver.exceptions import ToolError

from .lapis import (
    LAPIS_DATABASES,
    LAPIS_MAX_FILTER_DOWNLOAD_BYTES,
    LAPIS_MUTATION_FIELDS,
    LAPIS_TERMS_FIELDS,
    LapisResponseTooLarge,
    _lapis_check_filters,
    _lapis_data_use_terms,
    _lapis_date_field,
    _lapis_date_ranges,
    _lapis_organism,
    _lapis_post,
    _lapis_schema,
    _lapis_unknown_field,
    _lapis_version_filter,
)
from .server import mcp

# ********** list organisms **********


@mcp.tool()
def lapis_list_organisms() -> dict:
    """List the organisms the LAPIS tools can query, grouped by database.

    Pathoplexus holds human viral pathogens, GenSpectrum Loculus holds
    influenza lineages and dengue serotypes, and CoV-Spectrum holds open
    SARS-CoV-2 data.

    Example questions:
        "Which pathogens does the Pathogen Data Network have sequences for?"
        "Can I query H5N1 influenza sequences?"
    """
    return {
        "databases": [
            {
                "name": d["name"],
                "description": d["description"],
                "organisms": d["organisms"],
                "url_pattern": d["organism_url"],
            }
            for d in LAPIS_DATABASES.values()
        ],
        "next_step": ("Call lapis_describe_organism before you filter. Each organism declares its own fields."),
    }


# ********** describe organism **********


@mcp.tool()
def lapis_describe_organism(organism: str, field_search: str = "") -> dict:
    """Describe one organism: its fields, genes, segments, and filter syntax.

    Call this before you filter or group. Each organism names its fields
    differently. Pathoplexus has sampleCollectionDate, CoV-Spectrum has date.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "mpox".
        field_search: Text that a field name must contain, e.g. "country".
            Without it, the reply lists every field, often over 100, plus the
            segments and genes.

    Example questions:
        "Which fields can I filter mpox sequences on?"
        "Which genes can I query for measles?"
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    # A multi-segment organism, or any gene, needs the name before the
    # position. LAPIS rejects a bare nucleotide mutation in that case.
    prefix = f"{schema['segments'][0]}:" if len(schema["segments"]) > 1 else ""
    gene = schema["genes"][0] if schema["genes"] else "GENE"
    needle = field_search.lower()
    fields = [
        {"name": name, "type": field_type} for name, field_type in schema["fields"].items() if needle in name.lower()
    ]
    notes = []
    if "versionStatus" in schema["fields"]:
        notes.append(
            "The database keeps every revision of a sequence, and a revocation "
            "stays as its own record. Filter on versionStatus='LATEST_VERSION' "
            "and isRevocation=false to count each sequence once."
        )
    if schema["lineage_fields"]:
        notes.append(
            "A lineage field holds a hierarchy. A plain value matches that "
            "lineage alone, and a '*' suffix matches the lineage with every "
            "sublineage under it. On sars-cov-2 in September 2026, "
            "pangoLineage='JN.1' matched 29,360 sequences, and "
            "pangoLineage='JN.1*' matched 210,949. Use "
            "the '*' suffix unless you mean the one lineage. The lineage "
            f"fields here: {', '.join(schema['lineage_fields'])}."
        )
    if "dataUseTerms" in schema["fields"]:
        notes.append(
            "Some records carry RESTRICTED data use terms. Read dataUseTerms, "
            "dataUseTermsRestrictedUntil, and dataUseTermsUrl before you reuse "
            "a record."
        )
    description = {
        "organism": organism,
        "database": database["name"],
        "lapis_url": url,
        "instance_name": schema["instance_name"],
        "primary_key": schema["primary_key"],
    }
    # A field search is a field lookup, so it skips the segments and genes.
    if not field_search:
        description["segments"] = schema["segments"]
        description["genes"] = schema["genes"]
    description.update(
        {
            "phylo_tree_fields": schema["phylo_tree_fields"],
            "lineage_fields": schema["lineage_fields"],
            "field_search": field_search,
            "fields_matched": len(fields),
            "fields_total": len(schema["fields"]),
            "fields": fields,
            "filter_syntax": {
                "exact": ("Pass a field name with a value, or with a list of values to match any of them."),
                "range": (
                    "Add From or To to an int, float, or date field, e.g. "
                    "sampleCollectionDateRangeLowerFrom. A string field takes no "
                    "range, even when it holds a date."
                ),
                "lineages": (
                    "A lineage field takes a '*' suffix to match a lineage with "
                    "every sublineage under it, e.g. pangoLineage='JN.1*'. Without "
                    "the suffix, only that one lineage matches. The lineage fields "
                    "here: " + (", ".join(schema["lineage_fields"]) or "none") + "."
                ),
                "text and missing values": (
                    "Add .regex to a string field for a regular expression. Add "
                    ".isNull to any field, with true or false."
                ),
                "mutations": (
                    "nucleotideMutations or aminoAcidMutations with a list keeps "
                    "the sequences that carry every listed mutation, e.g. "
                    f"['{prefix}A123G'] or ['{gene}:N50Y']. The original symbol is "
                    f"optional, so '{gene}:50Y' also works."
                ),
                "advancedQuery": (
                    "One boolean expression over fields and mutations. It takes "
                    "AND, OR, NOT, the symbols & | !, IsNull(field), "
                    "field.regex='...', and [2-of: a, b, c] for a count of "
                    "matches. Example: \"geoLocCountry='Guinea' AND NOT "
                    'IsNull(hostNameScientific)".'
                ),
            },
            "notes": notes,
        }
    )
    return description


# ********** aggregate samples **********

LAPIS_MAX_GROUPS = 500


@mcp.tool()
def lapis_aggregate_samples(
    organism: str,
    group_by: list[str] | None = None,
    filters: dict[str, Any] | None = None,
    latest_version_only: bool = True,
    order_by: Literal["count", "group"] = "count",
    max_groups: int = 50,
) -> dict:
    """Count samples for one organism, as one total or grouped by fields.

    A count measures sequencing effort, not infection incidence. Never report
    it as a case count.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "mpox".
        group_by: Fields to group by, e.g. ["geoLocCountry"]. Empty gives one
            total.
        filters: Field filters, e.g. {"geoLocCountry": "Brazil",
            "sampleCollectionDateRangeLowerFrom": "2025-01-01"}. A lineage
            value needs a "*" to cover its sublineages, e.g.
            {"pangoLineage": "JN.1*"}. Mutation filters and advancedQuery work
            here too. lapis_describe_organism gives the field names and the
            full syntax.
        latest_version_only: Count each sequence once, skipping older versions
            and revocations (default True).
        order_by: "count" for the largest groups first, or "group" for the
            order of the group values.
        max_groups: Groups to return (default 50, max 500).

    Example questions:
        "How many mpox sequences come from each country?"
        "Which SARS-CoV-2 lineages were sequenced most in Switzerland?"
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    group_by = group_by or []
    for name in group_by:
        if name not in schema["fields"]:
            raise _lapis_unknown_field(schema, name)
    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    version_note = _lapis_version_filter(schema, body, latest_version_only)

    query = {**body, "fields": group_by}
    max_groups = max(1, min(max_groups, LAPIS_MAX_GROUPS))
    if group_by:
        # LAPIS rejects a limit on grouped counts unless an order is set.
        if order_by == "count":
            query["orderBy"] = [{"field": "count", "type": "descending"}]
        else:
            query["orderBy"] = [{"field": f, "type": "ascending"} for f in group_by]
        query["limit"] = max_groups

    rows, data_version = _lapis_post(f"{url}/sample/aggregated", query)
    notes = [
        (
            "A count measures sequencing effort, not infection incidence. A "
            "difference between places or dates often reflects how much each one "
            "sequences."
        )
    ]
    if version_note:
        notes.append(version_note)
    return {
        "organism": organism,
        "database": database["name"],
        "group_by": group_by,
        "rows_returned": len(rows),
        "truncated": bool(group_by) and len(rows) == max_groups,
        "rows": rows,
        "notes": notes,
        "query": {
            "url": f"{url}/sample/aggregated",
            "method": "POST",
            "body": query,
            "data_version": data_version,
        },
    }


# ********** get mutations **********

LAPIS_MAX_MUTATIONS = 500


@mcp.tool()
def lapis_get_mutations(
    organism: str,
    sequence_type: Literal["nucleotide", "amino_acid"],
    gene_or_segment: str = "",
    filters: dict[str, Any] | None = None,
    min_proportion: float = 0.05,
    latest_version_only: bool = True,
    order_by: Literal["proportion", "position"] = "proportion",
    max_mutations: int = 50,
) -> dict:
    """List the substitutions and deletions in one organism's sequences.

    A mutation reads <gene or segment>:<from><position><to>, e.g. S:N501Y, or
    C241T on a single-segment genome. A "-" marks a deletion. For insertions,
    call lapis_get_insertions.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "sars-cov-2".
        sequence_type: "amino_acid" for changes within genes, or "nucleotide".
        gene_or_segment: One gene or segment, e.g. "S". Empty gives all.
        filters: As in lapis_aggregate_samples.
        min_proportion: Drop mutations below this share (default 0.05, the
            LAPIS default). It is a reporting filter, not a biological cutoff.
            Lower it to 0 for rare mutations, though with gene_or_segment a
            low value can pass the size limit.
        latest_version_only: As in lapis_aggregate_samples.
        order_by: "proportion" for the most common first, or "position".
        max_mutations: Mutations to return (default 50, max 500).

    Example questions:
        "Which spike mutations are common in Swiss SARS-CoV-2 since 2025?"
        "Which nucleotide mutations are most common in mpox?"
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    if sequence_type == "amino_acid":
        endpoint = "/sample/aminoAcidMutations"
        names, kind = schema["genes"], "gene"
    else:
        endpoint = "/sample/nucleotideMutations"
        names, kind = schema["segments"], "segment"
    # A single-segment genome leaves sequenceName empty, so there is nothing
    # to filter on.
    name_filter = gene_or_segment if len(names) > 1 or kind == "gene" else ""
    if kind == "gene" and not names:
        raise ToolError(
            f"{schema['instance_name']} declares no genes, so it has no amino "
            "acid mutations. Use sequence_type 'nucleotide' instead."
        )
    if gene_or_segment and gene_or_segment not in names:
        close = difflib.get_close_matches(gene_or_segment, names, n=3, cutoff=0.5)
        hint = f" Close matches: {', '.join(close)}." if close else ""
        raise ToolError(
            f"'{gene_or_segment}' is not a {kind} of {schema['instance_name']}.{hint} Its {kind}s: {', '.join(names)}."
        )

    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    version_note = _lapis_version_filter(schema, body, latest_version_only)
    min_proportion = max(0.0, min(min_proportion, 1.0))
    max_mutations = max(1, min(max_mutations, LAPIS_MAX_MUTATIONS))
    query = {**body, "minProportion": min_proportion, "fields": LAPIS_MUTATION_FIELDS}
    if order_by == "proportion":
        order = [{"field": "proportion", "type": "descending"}]
    else:
        order = [
            {"field": "sequenceName", "type": "ascending"},
            {"field": "position", "type": "ascending"},
        ]
    # LAPIS cannot filter mutations by gene or segment. With a name filter,
    # fetch every mutation above the threshold and filter here, up to a size
    # limit. Without one, let LAPIS sort and cut, because a full nucleotide
    # list can pass 20 MB.
    if not name_filter:
        query.update({"orderBy": order, "limit": max_mutations})

    try:
        rows, data_version = _lapis_post(
            f"{url}{endpoint}",
            query,
            max_bytes=LAPIS_MAX_FILTER_DOWNLOAD_BYTES if name_filter else None,
        )
    except LapisResponseTooLarge:
        raise ToolError(
            f"The {sequence_type.replace('_', ' ')} mutations at or above "
            f"proportion {min_proportion} pass "
            f"{LAPIS_MAX_FILTER_DOWNLOAD_BYTES // 1_000_000} MB, which is too "
            f"much to filter down to {kind} {gene_or_segment}. Raise "
            "min_proportion, e.g. to 0.001, or narrow the filters."
        ) from None
    if name_filter:
        rows = [r for r in rows if r["sequenceName"] == name_filter]
        if order_by == "proportion":
            rows.sort(key=lambda r: -r["proportion"])
        else:
            rows.sort(key=lambda r: r["position"])
    truncated = len(rows) > max_mutations if name_filter else len(rows) == max_mutations
    rows = rows[:max_mutations]
    for row in rows:
        row["proportion"] = round(row["proportion"], 4)

    notes = [
        (
            "A proportion is the count divided by the coverage, among the "
            "sequences that match the filters. It shows how common a mutation is "
            "in sequenced samples, not among infections."
        ),
        "A proportion from a small coverage is unreliable. Check the coverage before you compare two mutations.",
        (
            "A mutation seen in only one or two sequences can be a sequencing or "
            "assembly artifact. Check the count before you treat it as real."
        ),
    ]
    if version_note:
        notes.append(version_note)
    return {
        "organism": organism,
        "database": database["name"],
        "sequence_type": sequence_type,
        "gene_or_segment": gene_or_segment,
        "min_proportion": min_proportion,
        "rows_returned": len(rows),
        "truncated": truncated,
        "rows": rows,
        "notes": notes,
        "query": {
            "url": f"{url}{endpoint}",
            "method": "POST",
            "body": query,
            "data_version": data_version,
        },
    }


# ********** get sample details **********

LAPIS_MAX_RECORDS = 100


@mcp.tool()
def lapis_get_sample_details(
    organism: str,
    fields: list[str],
    filters: dict[str, Any] | None = None,
    latest_version_only: bool = True,
    order_by: str = "",
    descending: bool = False,
    limit: int = 10,
    offset: int = 0,
) -> dict:
    """Get sample records for one organism, with the fields you name.

    For counts, use lapis_aggregate_samples, which returns far less text. Name
    only the fields you need: a record can carry over 150, and authors alone
    can run to thousands of characters.

    Pathoplexus records arrive with a data_use_terms block. Keep it with them,
    and follow it before you pass them on or publish from them.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "mpox".
        fields: Fields to return, e.g. ["geoLocCountry",
            "sampleCollectionDate"]. The accession and the data use terms come
            as well.
        filters: As in lapis_aggregate_samples.
        latest_version_only: As in lapis_aggregate_samples.
        order_by: A field to sort by, e.g. "sampleCollectionDate". Empty for
            the database order.
        descending: Sort from highest to lowest (default False).
        limit: Records to return (default 10, max 100).
        offset: Records to skip, for the next page (default 0).

    Example questions:
        "Show the 10 most recent mpox sequences from the DRC."
        "Which measles records on Pathoplexus are under restricted terms?"
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    if not fields:
        raise ToolError("Name at least one field. lapis_describe_organism lists the fields.")
    for name in [*fields, *([order_by] if order_by else [])]:
        if name not in schema["fields"]:
            raise _lapis_unknown_field(schema, name)
    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    version_note = _lapis_version_filter(schema, body, latest_version_only)

    terms_fields = [f for f in LAPIS_TERMS_FIELDS if f in schema["fields"]]
    returned_fields = list(dict.fromkeys([schema["primary_key"], *fields, *terms_fields]))
    limit = max(1, min(limit, LAPIS_MAX_RECORDS))
    offset = max(0, offset)
    query = {**body, "fields": returned_fields, "limit": limit, "offset": offset}
    if order_by:
        query["orderBy"] = [{"field": order_by, "type": "descending" if descending else "ascending"}]

    rows, data_version = _lapis_post(f"{url}/sample/details", query)
    # A count over the same filters tells the agent how many records remain.
    count_rows, _ = _lapis_post(f"{url}/sample/aggregated", body)
    total = count_rows[0]["count"]
    next_offset = offset + len(rows)

    notes = []
    if version_note:
        notes.append(version_note)
    result = {
        "organism": organism,
        "database": database["name"],
        "total": total,
        "offset": offset,
        "rows_returned": len(rows),
        "next_offset": next_offset if next_offset < total else None,
        "rows": rows,
    }
    terms = _lapis_data_use_terms(database, schema, rows)
    if terms:
        result["data_use_terms"] = terms
    result.update(
        {
            "notes": notes,
            "query": {
                "url": f"{url}/sample/details",
                "method": "POST",
                "body": query,
                "data_version": data_version,
            },
        }
    )
    return result


# ********** get sequences **********

LAPIS_MAX_SEQUENCE_RECORDS = 50

# One mpox genome runs to about 197,000 characters, so a record limit alone
# cannot keep a response small. This budget caps the sequence characters in
# one response, at roughly 12,000 tokens.
LAPIS_MAX_SEQUENCE_CHARS = 50_000


@mcp.tool()
def lapis_get_sequences(
    organism: str,
    alignment: Literal["unaligned_nucleotide", "aligned_nucleotide", "aligned_amino_acid"] = "unaligned_nucleotide",
    gene_or_segment: str = "",
    filters: dict[str, Any] | None = None,
    latest_version_only: bool = True,
    limit: int = 5,
) -> dict:
    """Get sequences for one organism as FASTA, for a local analysis.

    Sequences are long: one mpox genome runs to 197,000 characters. A response
    carries at most 50,000 characters of sequence and says when that cuts the
    list short, so ask for a gene or a segment. For mutations or counts, use
    lapis_get_mutations or lapis_aggregate_samples, which download none.

    A FASTA header carries no terms of use, so Pathoplexus sequences arrive
    with a data_use_terms block. Keep it with them.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "h5n1".
        alignment: "unaligned_nucleotide" as submitted, "aligned_nucleotide"
            padded to the reference, or "aligned_amino_acid" for a gene.
        gene_or_segment: Required for "aligned_amino_acid", e.g. "S". A
            segment for a nucleotide query on a multi-segment organism, e.g.
            "seg4". Empty gives every segment.
        filters: As in lapis_aggregate_samples. Filter on the accession to
            fetch named records.
        latest_version_only: As in lapis_aggregate_samples.
        limit: Records to fetch (default 5, max 50). The budget can still cut
            the list short.

    Example questions:
        "Give me the HA segment of 5 recent H5N1 sequences from cattle."
        "Fetch spike protein sequences from Swiss SARS-CoV-2 samples."
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    if alignment == "aligned_amino_acid":
        names, kind = schema["genes"], "gene"
        if not names:
            raise ToolError(
                f"{schema['instance_name']} declares no genes, so it has no "
                "amino acid sequences. Ask for a nucleotide alignment instead."
            )
        if not gene_or_segment:
            raise ToolError(f"Name the gene to translate. The genes of {schema['instance_name']}: {', '.join(names)}.")
        endpoint = f"/sample/alignedAminoAcidSequences/{gene_or_segment}"
    else:
        names, kind = schema["segments"], "segment"
        stem = "unalignedNucleotideSequences" if alignment == "unaligned_nucleotide" else "alignedNucleotideSequences"
        # A single-segment organism has no per-segment route.
        segment = gene_or_segment if len(names) > 1 else ""
        endpoint = f"/sample/{stem}/{segment}" if segment else f"/sample/{stem}"
    if gene_or_segment and gene_or_segment not in names:
        close = difflib.get_close_matches(gene_or_segment, names, n=3, cutoff=0.5)
        hint = f" Close matches: {', '.join(close)}." if close else ""
        raise ToolError(
            f"'{gene_or_segment}' is not a {kind} of {schema['instance_name']}.{hint} Its {kind}s: {', '.join(names)}."
        )

    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    version_note = _lapis_version_filter(schema, body, latest_version_only)
    limit = max(1, min(limit, LAPIS_MAX_SEQUENCE_RECORDS))
    query = {**body, "limit": limit, "dataFormat": "JSON"}

    rows, data_version = _lapis_post(f"{url}{endpoint}", query)
    # A row holds one sequence per segment or gene, beside the primary key.
    key = schema["primary_key"]
    parts = [(row[key], name, seq) for row in rows for name, seq in row.items() if name != key and isinstance(seq, str)]
    named = len({name for _, name, _ in parts}) > 1

    fasta, lengths, characters, truncated = [], [], 0, False
    for accession, name, sequence in parts:
        if characters + len(sequence) > LAPIS_MAX_SEQUENCE_CHARS:
            if not fasta:
                raise ToolError(
                    f"One {organism} sequence holds {len(sequence):,} characters, "
                    f"above the budget of {LAPIS_MAX_SEQUENCE_CHARS:,}. Ask for a "
                    f"single gene or segment, or use lapis_get_mutations to compare "
                    "sequences without downloading them."
                )
            truncated = True
            break
        header = f"{accession}|{name}" if named else accession
        fasta.append(f">{header}\n{sequence}")
        lengths.append({"accession": accession, kind: name, "length": len(sequence)})
        characters += len(sequence)

    terms = None
    terms_fields = [f for f in LAPIS_TERMS_FIELDS if f in schema["fields"]]
    accessions = list(dict.fromkeys(row["accession"] for row in lengths))
    if terms_fields and accessions:
        term_rows, _ = _lapis_post(f"{url}/sample/details", {key: accessions, "fields": [key, *terms_fields]})
        terms = _lapis_data_use_terms(database, schema, term_rows)

    notes = []
    if alignment.startswith("aligned"):
        notes.append(
            "An aligned sequence is padded to the reference, so it carries N "
            "and gap characters that the submitted sequence does not have."
        )
    if truncated:
        notes.append(
            "The character budget cut the list short. Lower limit, or ask for one gene or segment, to see the rest."
        )
    if version_note:
        notes.append(version_note)
    result = {
        "organism": organism,
        "database": database["name"],
        "alignment": alignment,
        "gene_or_segment": gene_or_segment,
        "records_returned": len(accessions),
        "sequences_returned": len(fasta),
        "total_characters": characters,
        "truncated": truncated,
        "lengths": lengths,
        "fasta": "\n".join(fasta),
    }
    if terms:
        result["data_use_terms"] = terms
    result.update(
        {
            "notes": notes,
            "query": {
                "url": f"{url}{endpoint}",
                "method": "POST",
                "body": query,
                "data_version": data_version,
            },
        }
    )
    return result


# ********** get insertions **********

LAPIS_MAX_INSERTIONS = 500


@mcp.tool()
def lapis_get_insertions(
    organism: str,
    sequence_type: Literal["nucleotide", "amino_acid"],
    gene_or_segment: str = "",
    filters: dict[str, Any] | None = None,
    latest_version_only: bool = True,
    min_count: int = 1,
    order_by: Literal["count", "position"] = "count",
    max_insertions: int = 50,
) -> dict:
    """List the insertions in one organism's sequences.

    lapis_get_mutations reports substitutions and deletions only, so an
    insertion needs this tool. The SARS-CoV-2 insertion ins_22204:GAGCCAGAA
    marks Omicron BA.1. An insertion reads ins_<position>:<symbols>, or
    ins_<gene or segment>:<position>:<symbols>, e.g. ins_seg8:79:TG. LAPIS
    reports no coverage for an insertion, so a count carries no proportion.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "h5n1".
        sequence_type: "nucleotide" for the genome, or "amino_acid" within
            genes.
        gene_or_segment: One gene or segment, e.g. "S". Empty gives all.
        filters: As in lapis_aggregate_samples.
        latest_version_only: As in lapis_aggregate_samples.
        min_count: Drop an insertion that fewer sequences carry (default 1).
        order_by: "count" for the most common first, or "position".
        max_insertions: Insertions to return (default 50, max 500).

    Example questions:
        "Which insertions do SARS-CoV-2 spike sequences carry?"
        "Which mpox insertions are most common?"
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    if sequence_type == "amino_acid":
        endpoint = "/sample/aminoAcidInsertions"
        names, kind = schema["genes"], "gene"
        if not names:
            raise ToolError(
                f"{schema['instance_name']} declares no genes, so it has no "
                "amino acid insertions. Use sequence_type 'nucleotide' instead."
            )
    else:
        endpoint = "/sample/nucleotideInsertions"
        names, kind = schema["segments"], "segment"
    # A single-segment genome leaves sequenceName empty, so there is nothing
    # to filter on.
    name_filter = gene_or_segment if len(names) > 1 or kind == "gene" else ""
    if gene_or_segment and gene_or_segment not in names:
        close = difflib.get_close_matches(gene_or_segment, names, n=3, cutoff=0.5)
        hint = f" Close matches: {', '.join(close)}." if close else ""
        raise ToolError(
            f"'{gene_or_segment}' is not a {kind} of {schema['instance_name']}.{hint} Its {kind}s: {', '.join(names)}."
        )

    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    version_note = _lapis_version_filter(schema, body, latest_version_only)
    max_insertions = max(1, min(max_insertions, LAPIS_MAX_INSERTIONS))
    query = dict(body)
    if order_by == "count":
        order = [{"field": "count", "type": "descending"}]
    else:
        order = [
            {"field": "sequenceName", "type": "ascending"},
            {"field": "position", "type": "ascending"},
        ]
    # LAPIS cannot filter insertions by gene or segment, so a name filter
    # fetches them all and filters here, as lapis_get_mutations does.
    if not name_filter:
        query.update({"orderBy": order, "limit": max_insertions})

    try:
        rows, data_version = _lapis_post(
            f"{url}{endpoint}",
            query,
            max_bytes=LAPIS_MAX_FILTER_DOWNLOAD_BYTES if name_filter else None,
        )
    except LapisResponseTooLarge:
        raise ToolError(
            f"The {sequence_type.replace('_', ' ')} insertions of {organism} pass "
            f"{LAPIS_MAX_FILTER_DOWNLOAD_BYTES // 1_000_000} MB, which is too much "
            f"to filter down to {kind} {gene_or_segment}. Narrow the filters."
        ) from None
    fetched = len(rows)
    if name_filter:
        rows = [r for r in rows if r["sequenceName"] == name_filter]
    rows = [r for r in rows if r["count"] >= min_count]
    if name_filter:
        rows.sort(key=lambda r: -r["count"] if order_by == "count" else r["position"])
    # LAPIS already cut the rows without a name filter, so a full page means
    # more insertions remain.
    truncated = len(rows) > max_insertions if name_filter else fetched == max_insertions
    rows = rows[:max_insertions]
    # The insertion name already carries the inserted symbols.
    rows = [{k: v for k, v in r.items() if k != "insertedSymbols"} for r in rows]

    notes = [
        (
            "A count is the number of sequences that carry the insertion, among "
            "the sequences that match the filters. LAPIS reports no coverage for "
            "an insertion, so there is no proportion."
        ),
        "An insertion that one or two sequences carry can be an assembly artifact.",
    ]
    if version_note:
        notes.append(version_note)
    return {
        "organism": organism,
        "database": database["name"],
        "sequence_type": sequence_type,
        "gene_or_segment": gene_or_segment,
        "min_count": min_count,
        "rows_returned": len(rows),
        "truncated": truncated,
        "rows": rows,
        "notes": notes,
        "query": {
            "url": f"{url}{endpoint}",
            "method": "POST",
            "body": query,
            "data_version": data_version,
        },
    }


# ********** get mutations over time **********


@mcp.tool()
def lapis_get_mutations_over_time(
    organism: str,
    sequence_type: Literal["nucleotide", "amino_acid"],
    mutations: list[str],
    date_from: str,
    date_to: str,
    interval: Literal["month", "quarter", "year"] = "month",
    filters: dict[str, Any] | None = None,
    latest_version_only: bool = True,
    date_field: str = "",
) -> dict:
    """Track named mutations over time, to see whether each one grows or fades.

    For each mutation and each period, the reply gives the sequences that carry
    it, the sequences that cover its position, and the proportion between them.
    A rising proportion is the signal to look for. lapis_get_mutations finds
    which mutations to name.

    Args:
        organism: An organism name from lapis_list_organisms, e.g. "sars-cov-2".
        sequence_type: "amino_acid" for changes within genes, or "nucleotide".
        mutations: The mutations to track, e.g. ["S:N501Y", "S:F456L"]. Name
            the gene, or the segment on a multi-segment organism.
        date_from: The first date, e.g. "2025-01-01".
        date_to: The last date, e.g. "2025-12-31".
        interval: "month", "quarter", or "year" (default "month").
        filters: As in lapis_aggregate_samples.
        latest_version_only: As in lapis_aggregate_samples.
        date_field: The date field to count over. Empty picks one, usually the
            collection date.

    Example questions:
        "Is S:F456L growing in Switzerland through 2025?"
        "How did the mpox clade Ib mutations spread over the last two years?"
    """
    database, url = _lapis_organism(organism)
    schema = _lapis_schema(organism)
    if not mutations:
        raise ToolError("Name at least one mutation. lapis_get_mutations lists the common ones.")
    if sequence_type == "amino_acid":
        endpoint = "/component/aminoAcidMutationsOverTime"
        names, kind = schema["genes"], "gene"
    else:
        endpoint = "/component/nucleotideMutationsOverTime"
        names, kind = schema["segments"], "segment"
    # LAPIS answers a malformed mutation with "Failed to read request", so
    # check the prefix here instead.
    shown = ", ".join(names[:10]) + (", ..." if len(names) > 10 else "")
    for mutation in mutations:
        prefix = mutation.split(":")[0] if ":" in mutation else ""
        if prefix and prefix not in names:
            raise ToolError(
                f"'{mutation}' starts with '{prefix}', which is not a {kind} of "
                f"{schema['instance_name']}. Its {kind}s: {shown}."
            )
        if not prefix and (kind == "gene" or len(names) > 1):
            example = f"{names[0]}:N50Y" if kind == "gene" else f"{names[0]}:A123G"
            raise ToolError(f"'{mutation}' needs a {kind} before the position, e.g. '{example}'.")

    body = dict(filters or {})
    _lapis_check_filters(schema, body)
    version_note = _lapis_version_filter(schema, body, latest_version_only)
    query = {
        "filters": body,
        "includeMutations": mutations,
        "dateRanges": _lapis_date_ranges(date_from, date_to, interval),
        "dateField": _lapis_date_field(schema, date_field),
    }

    result, data_version = _lapis_post(f"{url}{endpoint}", query)
    periods = [
        {"from": r["dateFrom"], "to": r["dateTo"], "sequences_with_a_date": total}
        for r, total in zip(result["dateRanges"], result["totalCountsByDateRange"])
    ]
    rows = []
    for mutation, series in zip(result["mutations"], result["data"]):
        rows.append(
            {
                "mutation": mutation,
                "count": [p["count"] for p in series],
                "coverage": [p["coverage"] for p in series],
                "proportion": [round(p["count"] / p["coverage"], 4) if p["coverage"] else None for p in series],
            }
        )

    notes = [
        (
            "Each count, coverage, and proportion follows the order of the "
            "periods. A proportion divides the count by the coverage of that "
            "period, so compare proportions, not counts."
        ),
        "A period with a small coverage moves a proportion a long way. Read the coverage beside every proportion.",
    ]
    if version_note:
        notes.append(version_note)
    return {
        "organism": organism,
        "database": database["name"],
        "sequence_type": sequence_type,
        "date_field": query["dateField"],
        "periods": periods,
        "rows": rows,
        "notes": notes,
        "query": {
            "url": f"{url}{endpoint}",
            "method": "POST",
            "body": query,
            "data_version": data_version,
        },
    }
