"""MyGene tools showing MCP Apps widgets: a gene card with its location, structure, GO terms and orthologs.

The widget gets the full data in `structuredContent`, the model only gets a text summary.
"""

import re
from collections import Counter
from typing import Any, TypedDict

from mcp.server.apps import Apps
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult

from .apps_common import text_result, widget_html

FIELDS = [
    "symbol",
    "name",
    "taxid",
    "entrezgene",
    "ensembl.gene",
    "type_of_gene",
    "alias",
    "other_names",
    "summary",
    "map_location",
    "genomic_pos",
    "exons",
    "uniprot.Swiss-Prot",
    "HGNC",
    "MGI",
    "MIM",
    "go",
    "pathway",
    "homologene",
]
# Species of HomoloGene, by taxonomy ID: scientific and common names
SPECIES = {
    9606: ("Homo sapiens", "human"),
    9598: ("Pan troglodytes", "chimpanzee"),
    9544: ("Macaca mulatta", "rhesus macaque"),
    9615: ("Canis lupus familiaris", "dog"),
    9913: ("Bos taurus", "cattle"),
    10090: ("Mus musculus", "mouse"),
    10116: ("Rattus norvegicus", "rat"),
    9031: ("Gallus gallus", "chicken"),
    8364: ("Xenopus tropicalis", "western clawed frog"),
    7955: ("Danio rerio", "zebrafish"),
    7227: ("Drosophila melanogaster", "fruit fly"),
    7165: ("Anopheles gambiae", "mosquito"),
    6239: ("Caenorhabditis elegans", "nematode"),
    4932: ("Saccharomyces cerevisiae", "baker's yeast"),
    4896: ("Schizosaccharomyces pombe", "fission yeast"),
    28985: ("Kluyveromyces lactis", "yeast"),
    33169: ("Eremothecium gossypii", "fungus"),
    318829: ("Magnaporthe oryzae", "rice blast fungus"),
    5141: ("Neurospora crassa", "bread mold"),
    3702: ("Arabidopsis thaliana", "thale cress"),
    4530: ("Oryza sativa", "rice"),
}
# Chromosome lengths and centromere positions (p/q boundary, None for acrocentric chromosomes drawn from the start)
KARYOTYPES: dict[int, tuple[str, dict[str, tuple[int, int | None]]]] = {
    9606: (
        "GRCh38",
        {
            "1": (248956422, 123400000),
            "2": (242193529, 93900000),
            "3": (198295559, 90900000),
            "4": (190214555, 50000000),
            "5": (181538259, 48800000),
            "6": (170805979, 59800000),
            "7": (159345973, 60100000),
            "8": (145138636, 45200000),
            "9": (138394717, 43000000),
            "10": (133797422, 39800000),
            "11": (135086622, 53400000),
            "12": (133275309, 35500000),
            "13": (114364328, 17700000),
            "14": (107043718, 17200000),
            "15": (101991189, 19000000),
            "16": (90338345, 36800000),
            "17": (83257441, 25100000),
            "18": (80373285, 18500000),
            "19": (58617616, 26200000),
            "20": (64444167, 28100000),
            "21": (46709983, 12000000),
            "22": (50818468, 15000000),
            "X": (156040895, 60600000),
            "Y": (57227415, 10400000),
        },
    ),
    10090: (
        "GRCm39",
        {
            "1": (195154279, None),
            "2": (181755017, None),
            "3": (159745316, None),
            "4": (156860686, None),
            "5": (151758149, None),
            "6": (149588044, None),
            "7": (144995196, None),
            "8": (130127694, None),
            "9": (124359700, None),
            "10": (130530862, None),
            "11": (121973369, None),
            "12": (120092757, None),
            "13": (120883175, None),
            "14": (125139656, None),
            "15": (104073951, None),
            "16": (98008968, None),
            "17": (95294699, None),
            "18": (90720763, None),
            "19": (61420004, None),
            "X": (169476592, None),
            "Y": (91455967, None),
        },
    ),
}
GO_ASPECTS = {"BP": "biological process", "MF": "molecular function", "CC": "cellular component"}
GO_EXPERIMENTAL = {"EXP", "IDA", "IPI", "IMP", "IGI", "IEP", "HTP", "HDA", "HMP", "HGI", "HEP", "TAS"}

apps = Apps()


# Data sent to the widget in `structuredContent`, as read by `widgets/mygene-card.html`
class Location(TypedDict):
    chr: str
    start: int
    end: int
    strand: int
    band: str | None
    assembly: str | None


class Transcript(TypedDict):
    id: str
    start: int
    end: int
    cdsStart: int | None
    cdsEnd: int | None
    exons: list[list[int]]


class GoTerm(TypedDict):
    id: str
    term: str
    evidence: list[str]
    experimental: bool
    qualifier: str | None


class Ortholog(TypedDict):
    taxid: int
    species: str
    commonName: str | None
    geneId: str
    symbol: str | None
    name: str | None


class Link(TypedDict):
    name: str
    id: str
    url: str


class GeneCardData(TypedDict):
    id: str
    symbol: str
    name: str | None
    taxid: int | None
    species: str | None
    commonName: str | None
    type: str | None
    aliases: list[str]
    otherNames: list[str]
    summary: str | None
    location: Location | None
    karyotype: dict[str, list[int | None]] | None
    """Chromosome name: [length, centromere], for human and mouse"""
    transcript: Transcript | None
    """Representative transcript, the RefSeq one with the most exons"""
    transcripts: int
    go: dict[str, list[GoTerm]]
    pathways: dict[str, int]
    """Number of pathways per source"""
    orthologs: list[Ortholog]
    links: list[Link]


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    # Imported when called: `mygene.py` imports `apps` from this module to build its server
    from .mygene import _get as get

    return get(path, params)


def _post(path: str, body: dict[str, Any]) -> Any:
    from .mygene import _post as post

    return post(path, body)


def as_list(value: Any) -> list[Any]:
    """MyGene gives a dict for one item, a list for several"""
    return value if isinstance(value, list) else [] if value is None else [value]


def resolve_gene(gene: str, species: str) -> str:
    """MyGene ID of a symbol in a species, or an Entrez or Ensembl ID as is"""
    from .mygene import _resolve_species

    g = gene.strip()
    if not g:
        raise ToolError("Give a gene symbol (TP53) or an Entrez (7157) or Ensembl (ENSG00000141510) gene ID")
    if g.isdigit() or re.fullmatch(r"ENS[A-Z]*G\d+(\.\d+)?", g):
        return g.split(".")[0]
    taxa = _resolve_species(species) or "human"
    # Official symbol, else an alias, else any match, e.g. TP53 in mouse is Trp53
    for q in (f"symbol:{g}", f"alias:{g}", g):
        hits = _get("/query", {"q": q, "species": taxa, "fields": "symbol", "size": 1}).get("hits", [])
        if hits:
            return hits[0]["_id"]
    raise ToolError(f"No gene {g!r} in species {species}, check the symbol or give an Entrez gene ID")


def location_of(doc: dict[str, Any], karyotype: dict[str, Any] | None) -> Location | None:
    """Position on a chromosome of the karyotype, else the first one with a short name (not a scaffold)"""
    positions = [p for p in as_list(doc.get("genomic_pos")) if p.get("chr") and p.get("start")]
    pos = next((p for p in positions if karyotype and p["chr"] in karyotype), None) or next(
        (p for p in positions if len(p["chr"]) <= 5), next(iter(positions), None)
    )
    if not pos:
        return None
    return {
        "chr": pos["chr"],
        "start": pos["start"],
        "end": pos["end"],
        "strand": pos.get("strand") or 0,
        "band": doc.get("map_location"),
        "assembly": KARYOTYPES[doc["taxid"]][0] if karyotype and pos["chr"] in karyotype else None,
    }


def transcript_of(doc: dict[str, Any], loc: Location | None) -> tuple[Transcript | None, int]:
    """Representative transcript on the gene chromosome: a RefSeq NM_ with the lowest number, usually the first
    described and the canonical one"""
    transcripts = [
        t for t in as_list(doc.get("exons")) if t.get("position") and (not loc or t.get("chr") == loc["chr"])
    ]
    if not transcripts:
        return None, 0

    def rank(t: dict[str, Any]) -> tuple[bool, int, int]:
        number = re.search(r"\d+", t.get("transcript", ""))
        return t.get("transcript", "").startswith("NM_"), -int(number[0] if number else 0), len(t["position"])

    t = max(transcripts, key=rank)
    return {
        "id": t.get("transcript", ""),
        "start": t["txstart"],
        "end": t["txend"],
        "cdsStart": t.get("cdsstart"),
        "cdsEnd": t.get("cdsend"),
        "exons": sorted(t["position"]),
    }, len(transcripts)


def go_terms(doc: dict[str, Any]) -> dict[str, list[GoTerm]]:
    """GO terms per aspect, one per term with all its evidence codes, experimental ones first"""
    out: dict[str, list[GoTerm]] = {}
    for aspect in GO_ASPECTS:
        terms: dict[str, GoTerm] = {}
        for a in as_list((doc.get("go") or {}).get(aspect)):
            t = terms.setdefault(
                a["id"],
                GoTerm(
                    id=a["id"], term=a.get("term", ""), evidence=[], experimental=False, qualifier=a.get("qualifier")
                ),
            )
            if a.get("evidence") and a["evidence"] not in t["evidence"]:
                t["evidence"].append(a["evidence"])
                t["experimental"] |= a["evidence"] in GO_EXPERIMENTAL
        out[aspect] = sorted(terms.values(), key=lambda t: (not t["experimental"], t["term"].lower()))
    return out


def orthologs_of(doc: dict[str, Any]) -> list[Ortholog]:
    """HomoloGene orthologs, their symbols and names in one batch query"""
    pairs = [
        (taxid, str(gid)) for taxid, gid in (doc.get("homologene") or {}).get("genes", []) if str(gid) != doc["_id"]
    ]
    if not pairs:
        return []
    found = {
        str(g["_id"]): g
        for g in as_list(_post("/gene", {"ids": [gid for _, gid in pairs], "fields": "symbol,name,taxid"}))
        if not g.get("notfound")
    }
    orthologs = [
        Ortholog(
            taxid=taxid,
            species=SPECIES.get(taxid, (f"taxon {taxid}", None))[0],
            commonName=SPECIES.get(taxid, ("", None))[1],
            geneId=gid,
            symbol=found.get(gid, {}).get("symbol"),
            name=found.get(gid, {}).get("name"),
        )
        for taxid, gid in pairs
    ]
    # Order of the species list above: primates, mammals, other vertebrates, invertebrates, fungi, plants
    order = list(SPECIES)
    return sorted(orthologs, key=lambda o: order.index(o["taxid"]) if o["taxid"] in order else len(order))


def links_of(doc: dict[str, Any]) -> list[Link]:
    links = [Link(name="Entrez", id=str(doc["_id"]), url=f"https://www.ncbi.nlm.nih.gov/gene/{doc['_id']}")]
    for e in as_list(doc.get("ensembl"))[:1]:
        links.append(Link(name="Ensembl", id=e["gene"], url=f"https://www.ensembl.org/id/{e['gene']}"))
    for acc in as_list((doc.get("uniprot") or {}).get("Swiss-Prot"))[:3]:
        links.append(Link(name="UniProt", id=acc, url=f"https://www.uniprot.org/uniprotkb/{acc}/entry"))
    if doc.get("HGNC"):
        url = f"https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/HGNC:{doc['HGNC']}"
        links.append(Link(name="HGNC", id=f"HGNC:{doc['HGNC']}", url=url))
    if doc.get("MGI"):
        links.append(Link(name="MGI", id=doc["MGI"], url=f"https://www.informatics.jax.org/marker/{doc['MGI']}"))
    if doc.get("MIM"):
        links.append(Link(name="OMIM", id=str(doc["MIM"]), url=f"https://omim.org/entry/{doc['MIM']}"))
    return links


@apps.tool(resource_uri="ui://mygene/card.html")
def show_gene_card(gene: str, species: str = "human") -> CallToolResult:
    """Show a card of a gene to the user: names and summary, location on a chromosome (karyotype for human and
    mouse), exon structure, Gene Ontology terms, pathways, orthologs in other species, and links to Entrez, Ensembl,
    UniProt, HGNC, MGI and OMIM.

    Args:
        gene: a gene symbol (TP53, Trp53) or an Entrez (7157) or Ensembl (ENSG00000141510) gene ID
        species: common name (human, mouse, rat, zebrafish, fruitfly...) or NCBI taxonomy ID, for a symbol
    """
    gene_id = resolve_gene(gene, species)
    doc = _get(f"/gene/{gene_id}", {"fields": FIELDS})
    taxid = doc.get("taxid")
    karyotype = KARYOTYPES.get(taxid, (None, None))[1]
    loc = location_of(doc, karyotype)
    transcript, n_transcripts = transcript_of(doc, loc)
    go = go_terms(doc)
    pathways = {k: len(as_list(v)) for k, v in (doc.get("pathway") or {}).items() if v}
    orthologs = orthologs_of(doc)
    species_name, common = SPECIES.get(taxid, (f"taxon {taxid}", None))
    data = GeneCardData(
        id=str(doc["_id"]),
        symbol=doc.get("symbol", gene),
        name=doc.get("name"),
        taxid=taxid,
        species=species_name,
        commonName=common,
        type=doc.get("type_of_gene"),
        aliases=as_list(doc.get("alias")),
        otherNames=as_list(doc.get("other_names"))[:10],
        summary=doc.get("summary"),
        location=loc,
        karyotype={c: [length, cen] for c, (length, cen) in karyotype.items()} if karyotype and loc else None,
        transcript=transcript,
        transcripts=n_transcripts,
        go=go,
        pathways=pathways,
        orthologs=orthologs,
        links=links_of(doc),
    )

    # Summary for the model
    where = (
        f"chr{loc['chr']}:{loc['start']}-{loc['end']} ({'+' if loc['strand'] > 0 else '-'} strand"
        f"{', ' + loc['assembly'] if loc['assembly'] else ''}), band {loc['band'] or '-'}"
        if loc
        else "unknown location"
    )
    structure = (
        f"{len(transcript['exons'])} exons in {transcript['id']}, {n_transcripts} transcripts" if transcript else ""
    )
    lines = [
        (
            f"Shown to the user: gene card of {data['symbol']} ({data['name']}, {species_name}, Entrez {data['id']}, "
            f"{data['type'] or '-'})"
        ),
        f"Location: {where}. {structure}",
        f"Aliases: {', '.join(data['aliases']) or '-'}",
        f"Summary: {data['summary'] or '-'}",
        "GO terms: "
        + ", ".join(
            f"{len(go[a])} {name} ({sum(t['experimental'] for t in go[a])} experimental)"
            for a, name in GO_ASPECTS.items()
        ),
        f"Pathways: {', '.join(f'{k} {n}' for k, n in Counter(pathways).most_common()) or '-'}",
        f"Orthologs: {'; '.join(f'{o['species']} {o['symbol']} ({o['geneId']})' for o in orthologs) or '-'}",
        f"Links: {', '.join(f'{li['name']} {li['id']}' for li in data['links'])}",
        "The user can browse the GO terms and ask about the orthologs in the card.",
    ]
    return text_result("\n".join(lines), data)


apps.add_html_resource("ui://mygene/card.html", widget_html("mygene-card.html"), title="MyGene gene card")
