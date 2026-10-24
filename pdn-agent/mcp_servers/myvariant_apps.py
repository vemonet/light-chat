"""MyVariant tools showing MCP Apps widgets: a variant card with ClinVar, gnomAD frequencies and predictions.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
"""

import re
from collections import Counter
from typing import Any, TypedDict

from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult

from .apps_common import apps, text_result, widget_html

# Fields of the card, a full document can be hundreds of KB
FIELDS = [
    "chrom",
    "vcf",
    "hg19",
    "hg38",
    "dbsnp.rsid",
    "dbsnp.vartype",
    "dbsnp.gene.symbol",
    "clinvar",
    "snpeff.ann",
    "cadd.phred",
    "dbnsfp.cadd.phred",
    "dbnsfp.sift",
    "dbnsfp.polyphen2.hvar",
    "dbnsfp.revel",
    "dbnsfp.alphamissense",
    "dbnsfp.genename",
    "dbnsfp.uniprot.acc",
    *(f"{d}.{f}" for d in ("gnomad_genome", "gnomad_exome") for f in ("af", "ac.ac", "an.an", "hom.hom")),
]
# gnomAD populations, by their code in the `af_<code>` fields
POPULATIONS = {
    "afr": "African/African American",
    "amr": "Admixed American",
    "asj": "Ashkenazi Jewish",
    "eas": "East Asian",
    "fin": "Finnish",
    "nfe": "Non-Finnish European",
    "sas": "South Asian",
    "mid": "Middle Eastern",
    "ami": "Amish",
    "oth": "Remaining",
}
# ClinVar review status as gold stars, like on the ClinVar website
STARS = {
    "practice guideline": 4,
    "reviewed by expert panel": 3,
    "criteria provided, multiple submitters, no conflicts": 2,
    "criteria provided, conflicting classifications": 1,
    "criteria provided, conflicting interpretations": 1,
    "criteria provided, single submitter": 1,
}
MAX_ALLELES = 6
HGVS_G = re.compile(r"^(chr\w+):g\.(\d+)(?:_(\d+))?([a-z]+)$")


# Data sent to the widget in `structuredContent`, as read by `widgets/myvariant-card.html`
class ClinvarRecord(TypedDict):
    accession: str
    significance: str
    condition: str
    reviewStatus: str
    stars: int
    lastEvaluated: str | None
    submitters: int | None


class Clinvar(TypedDict):
    variantId: int | None
    significance: str
    """Most reported significance, of the records with a condition"""
    counts: dict[str, int]
    stars: int
    """Best review status of the records"""
    records: list[ClinvarRecord]
    url: str | None


class Population(TypedDict):
    code: str
    name: str
    af: float


class Frequencies(TypedDict):
    af: float | None
    ac: int | None
    an: int | None
    hom: int | None
    populations: list[Population]


class Prediction(TypedDict):
    name: str
    score: float
    min: float
    max: float
    thresholds: list[float]
    """Limits between the levels, from low to high scores"""
    higherIsWorse: bool
    level: str
    """`damaging`, `uncertain` or `benign`"""
    label: str


class VariantCard(TypedDict):
    id: str
    assembly: str
    chrom: str | None
    pos: int | None
    ref: str | None
    alt: str | None
    hg19: str | None
    hg38: str | None
    rsid: str | None
    gene: str | None
    type: str | None
    consequence: str | None
    impact: str | None
    hgvsC: str | None
    hgvsP: str | None
    transcript: str | None
    uniprot: str | None
    clinvar: Clinvar | None
    gnomad: dict[str, Frequencies]
    """`genome` and `exome`, when the variant is in gnomAD"""
    predictions: list[Prediction]
    links: dict[str, str]


class VariantCardData(TypedDict):
    query: str
    variants: list[VariantCard]
    """The variant first, then the other alleles of the same rsID or ClinVar ID"""
    note: str | None


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    # Imported when called: `myvariant.py` imports the server, which imports this module
    from .myvariant import _get as get

    return get(path, params)


def as_list(value: Any) -> list[Any]:
    """MyVariant gives a dict for one item, a list for several"""
    return value if isinstance(value, list) else [] if value is None else [value]


def first(value: Any) -> Any:
    return next(iter(as_list(value)), None)


def coords(pos: Any) -> str | None:
    """`start-end` or `start` of a hg19 or hg38 field"""
    if not isinstance(pos, dict) or "start" not in pos:
        return None
    return str(pos["start"]) if pos["start"] == pos.get("end", pos["start"]) else f"{pos['start']}-{pos['end']}"


def clinvar_of(doc: dict[str, Any]) -> Clinvar | None:
    cv = first(doc.get("clinvar"))
    if not cv:
        return None
    records: list[ClinvarRecord] = []
    for r in as_list(cv.get("rcv")):
        conditions = as_list(r.get("conditions"))
        status = r.get("review_status") or ""
        records.append(
            {
                "accession": r.get("accession", ""),
                "significance": r.get("clinical_significance") or "not provided",
                "condition": "; ".join(c.get("name", "") for c in conditions if c.get("name")) or "not provided",
                "reviewStatus": status,
                "stars": STARS.get(status, 0),
                "lastEvaluated": r.get("last_evaluated"),
                "submitters": r.get("number_submitters"),
            }
        )
    records.sort(key=lambda r: (-r["stars"], -(r["submitters"] or 0)))
    counts = Counter(r["significance"] for r in records)
    # Records with a condition say more than the "not provided" ones
    named = Counter(r["significance"] for r in records if r["condition"] != "not provided") or counts
    significance = named.most_common(1)[0][0] if named else "not provided"
    return {
        "variantId": cv.get("variant_id"),
        "significance": significance,
        "counts": dict(counts.most_common()),
        "stars": max((r["stars"] for r in records), default=0),
        "records": records,
        "url": f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{cv['variant_id']}/" if cv.get("variant_id") else None,
    }


def frequencies_of(g: Any) -> Frequencies | None:
    g = first(g)
    if not isinstance(g, dict) or not isinstance(g.get("af"), dict):
        return None
    af = g["af"]
    populations = [
        Population(code=code, name=name, af=af[f"af_{code}"])
        for code, name in POPULATIONS.items()
        if isinstance(af.get(f"af_{code}"), (int, float))
    ]
    return {
        "af": af.get("af"),
        "ac": (g.get("ac") or {}).get("ac"),
        "an": (g.get("an") or {}).get("an"),
        "hom": (g.get("hom") or {}).get("hom"),
        "populations": populations,
    }


def scores(value: Any) -> list[float]:
    """Numeric scores of a dbNSFP field, one per transcript"""
    return [v for v in as_list(value) if isinstance(v, (int, float))]


def predictions_of(doc: dict[str, Any]) -> list[Prediction]:
    """Deleteriousness predictions with their usual thresholds, the most severe of the transcripts"""
    nsfp = doc.get("dbnsfp") or {}
    out: list[Prediction] = []

    def add(name: str, values: list[float], hi: float, thresholds: list[float], labels: list[str], levels: list[str]):
        """`labels` and `levels` from low to high scores, lower scores are worse when the first level is damaging"""
        if not values:
            return
        worse_high = levels[0] != "damaging"
        score = max(values) if worse_high else min(values)
        index = sum(score >= t for t in thresholds)
        out.append(
            Prediction(
                name=name,
                score=score,
                min=0,
                max=hi,
                thresholds=thresholds,
                higherIsWorse=worse_high,
                level=levels[index],
                label=labels[index],
            )
        )

    cadd = scores((doc.get("cadd") or {}).get("phred")) or scores((nsfp.get("cadd") or {}).get("phred"))
    three = ["benign", "uncertain", "damaging"]
    add("CADD phred", cadd, 50, [10, 20], ["likely benign", "top 10% deleterious", "top 1% deleterious"], three)
    sift = scores((nsfp.get("sift") or {}).get("score"))
    add("SIFT", sift, 1, [0.05], ["deleterious", "tolerated"], ["damaging", "benign"])
    polyphen = scores(((nsfp.get("polyphen2") or {}).get("hvar") or {}).get("score"))
    add("PolyPhen-2 HVAR", polyphen, 1, [0.447, 0.909], ["benign", "possibly damaging", "probably damaging"], three)
    revel = scores((nsfp.get("revel") or {}).get("score"))
    add("REVEL", revel, 1, [0.29, 0.644], ["likely benign", "uncertain", "likely pathogenic"], three)
    am = scores((nsfp.get("alphamissense") or {}).get("score"))
    add("AlphaMissense", am, 1, [0.34, 0.564], ["likely benign", "ambiguous", "likely pathogenic"], three)
    return out


def card_of(doc: dict[str, Any], assembly: str) -> VariantCard:
    vcf = doc.get("vcf") or {}
    ann = first((doc.get("snpeff") or {}).get("ann")) or {}
    clinvar_doc = first(doc.get("clinvar")) or {}
    dbsnp = first(doc.get("dbsnp")) or {}
    nsfp = doc.get("dbnsfp") or {}
    gene = (
        ann.get("genename")
        or first(nsfp.get("genename"))
        or (clinvar_doc.get("gene") or {}).get("symbol")
        or (first(dbsnp.get("gene")) or {}).get("symbol")
    )
    rsid = dbsnp.get("rsid") or clinvar_doc.get("rsid")
    pos = int(vcf["position"]) if str(vcf.get("position", "")).isdigit() else None
    chrom = doc.get("chrom")
    gnomad = {k: f for k in ("genome", "exome") if (f := frequencies_of(doc.get(f"gnomad_{k}")))}
    clinvar = clinvar_of(doc)

    # Links of the sources the variant is in
    links = {}
    if rsid:
        links["dbSNP"] = f"https://www.ncbi.nlm.nih.gov/snp/{rsid}"
    if clinvar and clinvar["url"]:
        links["ClinVar"] = clinvar["url"]
    if gnomad and pos and vcf.get("ref") and vcf.get("alt"):
        dataset = "gnomad_r4" if assembly == "hg38" else "gnomad_r2_1"
        links["gnomAD"] = (
            f"https://gnomad.broadinstitute.org/variant/{chrom}-{pos}-{vcf['ref']}-{vcf['alt']}?dataset={dataset}"
        )
    if rsid:
        links["Ensembl"] = f"https://www.ensembl.org/Homo_sapiens/Variation/Explore?v={rsid}"
    links["MyVariant"] = f"https://myvariant.info/v1/variant/{doc['_id']}?assembly={assembly}"

    effect = ann.get("effect")
    return {
        "id": doc["_id"],
        "assembly": assembly,
        "chrom": chrom,
        "pos": pos,
        "ref": vcf.get("ref"),
        "alt": vcf.get("alt"),
        "hg19": coords(doc.get("hg19") or clinvar_doc.get("hg19")),
        "hg38": coords(doc.get("hg38") or clinvar_doc.get("hg38")),
        "rsid": rsid,
        "gene": gene,
        "type": clinvar_doc.get("type") or dbsnp.get("vartype"),
        "consequence": effect.replace("_variant", "").replace("_", " ").replace("&", ", ") if effect else None,
        "impact": ann.get("putative_impact"),
        "hgvsC": ann.get("hgvs_c"),
        "hgvsP": ann.get("hgvs_p"),
        "transcript": ann.get("feature_id"),
        "uniprot": (first(nsfp.get("uniprot")) or {}).get("acc"),
        "clinvar": clinvar,
        "gnomad": gnomad,
        "predictions": predictions_of(doc),
        "links": links,
    }


def informative(doc: dict[str, Any]) -> bool:
    return any(doc.get(k) for k in ("clinvar", "gnomad_genome", "gnomad_exome"))


def ref_bases(doc: dict[str, Any]) -> dict[int, str]:
    """Reference bases by position, from the VCF fields of a deletion: the base before then the deleted ones"""
    vcf = doc.get("vcf") or {}
    if not str(vcf.get("position", "")).isdigit():
        return {}
    return {int(vcf["position"]) + i: b for i, b in enumerate(vcf.get("ref") or "")}


def shifted_equivalents(doc: dict[str, Any], assembly: str) -> list[dict[str, Any]]:
    """The same deletion or duplication normalized at another position: dbSNP, ClinVar and gnomAD shift indels in
    repeats differently. Two deletions of length L at s1 < s2 are the same when ref[i] == ref[i + L] for s1 <= i < s2"""
    m = HGVS_G.match(doc["_id"])
    if not m or m[4] not in ("del", "dup"):
        return []
    chrom, start, end = m[1], int(m[2]), int(m[3] or m[2])
    length = end - start + 1
    query = {"q": f"{chrom}:{start - 10}-{end + 10}", "fields": FIELDS, "assembly": assembly, "size": 200}
    hits = [h for h in _get("/query", query).get("hits", []) if h["_id"] != doc["_id"]]
    bases = ref_bases(doc)
    for h in hits:
        bases |= ref_bases(h)
    same = []
    for h in hits:
        n = HGVS_G.match(h["_id"])
        if not n or n[4] != m[4] or int(n[3] or n[2]) - int(n[2]) + 1 != length:
            continue
        s1, s2 = sorted((start, int(n[2])))
        if all(bases.get(i) and bases.get(i) == bases.get(i + length) for i in range(s1, s2)):
            same.append(h)
    return same


def rank(doc: dict[str, Any]) -> tuple[bool, float, bool]:
    """In ClinVar first, then the most frequent in gnomAD"""
    freq = frequencies_of(doc.get("gnomad_genome")) or frequencies_of(doc.get("gnomad_exome"))
    return bool(doc.get("clinvar")), (freq or {}).get("af") or 0, bool(doc.get("dbsnp"))


def fetch_variants(variant: str, assembly: str) -> tuple[list[dict[str, Any]], str | None]:
    """Documents of a rsID, ClinVar variation ID or genomic HGVS ID, the best first, and a note for the user"""
    v = variant.strip()
    clinvar_id = re.fullmatch(r"(?:VCV0*)?(\d+)(?:\.\d+)?", v, re.IGNORECASE)
    if re.fullmatch(r"rs\d+", v, re.IGNORECASE):
        q = f"dbsnp.rsid:{v.lower()} OR clinvar.rsid:{v.lower()}"
    elif clinvar_id:
        q = f"clinvar.variant_id:{clinvar_id[1]}"
    elif HGVS_G.match(v) or re.match(r"^chr\w+:g\.\d+", v):
        try:
            doc = _get(f"/variant/{v}", {"fields": FIELDS, "assembly": assembly})
        except ToolError:
            doc = None
        if doc and informative(doc):
            return [doc], None
        if doc:
            same = sorted(shifted_equivalents(doc, assembly), key=rank, reverse=True)
            if same and informative(same[0]):
                note = f"{v} has no ClinVar or gnomAD record ({assembly}), shown: the same indel at another position"
                return [*same, doc], note
            return [doc], None
        raise ToolError(
            f"{v} not found in MyVariant ({assembly}). Check the assembly (hg19 or hg38) and the HGVS normalization, "
            "or search with myvariant_search_variants"
        )
    else:
        raise ToolError(
            f"{v!r} is not a rsID (rs334), a ClinVar variation ID (7105) or a genomic HGVS ID "
            "(chr7:g.117559591_117559593del). Map other IDs with myvariant_map_ids first"
        )
    hits = _get("/query", {"q": q, "fields": FIELDS, "assembly": assembly, "size": 20}).get("hits", [])
    if not hits:
        raise ToolError(f"{v} not found in MyVariant ({assembly})")
    return sorted(hits, key=rank, reverse=True), None


def af_text(f: Frequencies) -> str:
    pops = sorted(f["populations"], key=lambda p: -p["af"])
    top = ", ".join(f"{p['name']} {p['af']:.3g}" for p in pops[:4])
    return f"AF {f['af']:.3g} (AC {f['ac']}, AN {f['an']}, homozygotes {f['hom']}); highest: {top}"


def card_text(c: VariantCard) -> list[str]:
    change = ", ".join(x for x in [c["type"], c["consequence"], c["hgvsC"], c["hgvsP"]] if x)
    where = f"{c['id']} ({c['assembly']}), {c['rsid'] or 'no rsID'}, gene {c['gene'] or '-'}"
    lines = [f"{where}: {change} ({c['transcript'] or '-'}, impact {c['impact'] or '-'})"]
    if cv := c["clinvar"]:
        conditions = "; ".join(
            f"{r['significance']}: {r['condition']} ({r['stars']} stars, {r['reviewStatus']})"
            for r in cv["records"][:8]
        )
        lines.append(
            f"ClinVar {cv['variantId']}: {cv['significance']}, best review {cv['stars']} stars. "
            f"Counts: {', '.join(f'{k} {n}' for k, n in cv['counts'].items())}. Records: {conditions}"
        )
    else:
        lines.append("Not in ClinVar")
    for k, f in c["gnomad"].items():
        lines.append(f"gnomAD {k}: {af_text(f)}")
    if not c["gnomad"]:
        lines.append("Not in gnomAD")
    if c["predictions"]:
        lines.append(
            "Predictions: " + "; ".join(f"{p['name']} {p['score']:.3g} ({p['label']})" for p in c["predictions"])
        )
    return lines


@apps.tool(resource_uri="ui://myvariant/card.html")
def show_variant_card(variant: str, assembly: str = "hg38") -> CallToolResult:
    """Show a card of a human variant to the user: gene and consequence, ClinVar clinical significance per condition
    with review status, gnomAD allele frequencies per population (genomes and exomes), deleteriousness predictions
    (CADD, SIFT, PolyPhen-2, REVEL, AlphaMissense) with their interpretation, and links to dbSNP, ClinVar and gnomAD.
    The other alleles of a rsID are shown too, the user can switch between them.

    Args:
        variant: a rsID (rs334), a ClinVar variation ID (7105) or a genomic HGVS ID (chr7:g.117559591_117559593del)
        assembly: `hg38` (default) or `hg19`, of the HGVS ID coordinates
    """
    assembly = assembly.strip().lower()
    if assembly not in ("hg19", "hg38"):
        raise ToolError("assembly must be hg19 or hg38")
    try:
        docs, note = fetch_variants(variant, assembly)
    except ToolError:
        # HGVS IDs are often given in the other assembly
        if not variant.strip().startswith("chr"):
            raise
        other = "hg19" if assembly == "hg38" else "hg38"
        docs, note = fetch_variants(variant, other)
        note = f"{variant} not found in {assembly}, shown in {other}" + (f". {note}" if note else "")
        assembly = other
    cards = [card_of(d, assembly) for d in docs[:MAX_ALLELES]]

    main = cards[0]
    lines = [f"Shown to the user: variant card of {main['id']}", *card_text(main)]
    if note:
        lines.insert(1, note)
    if len(cards) > 1:
        others = [
            f"{c['id']} ({c['clinvar']['significance'] if c['clinvar'] else 'not in ClinVar'})" for c in cards[1:]
        ]
        lines.append(f"Other alleles the user can switch to: {'; '.join(others)}")
    return text_result("\n".join(lines), VariantCardData(query=variant, variants=cards, note=note))


apps.add_html_resource("ui://myvariant/card.html", widget_html("myvariant-card.html"), title="MyVariant variant card")
