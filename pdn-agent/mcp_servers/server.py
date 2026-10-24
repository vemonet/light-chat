"""Pathogen Data Network MCP server, with the tools of each resource registered from their own module"""

from mcp.server.mcpserver import MCPServer

# Modules of the widget tools and resources, registered on `apps` before the server reads them when created
from . import brc_analytics_apps, geo_apps, mygene_apps, myvariant_apps, pdn_apps, string_apps  # noqa: F401
from .apps_common import apps
from .ncbi import apps as ncbi_apps  # noqa: F401
from .nde import apps as nde_apps  # noqa: F401

INSTRUCTIONS = """Biological data resources on pathogens, genes, variants, expression studies, literature and datasets.
Tools starting with `show_` (and `search_datasets_table`) show an interactive widget to the user, and return a summary.

### Pathogen Data Network (`lapis_*`)

Pathogen sequences and their metadata in the Pathogen Data Network (PDN) databases, through LAPIS: mutation and
lineage frequencies, by country and over time.

### MyGene.info (`mygene_*`) and MyVariant.info (`myvariant_*`)

MyGene.info for gene annotation: symbols, names, genomic position, Gene Ontology terms, pathways, orthologs, and
cross-references to Entrez, Ensembl, RefSeq, UniProt and HGNC.
MyVariant.info for variant annotation: clinical significance, population frequency, deleteriousness predictions, and
functional consequence, cross-referenced to ClinVar, dbSNP, gnomAD and CIViC.

### NCBI (`ncbi_*`)

Two NCBI services.

E-utilities: sequencing runs (SRA), samples (BioSample), projects (BioProject), organisms (Taxonomy), genes, genome
assemblies, and sequences.

Pathogen Detection (`ncbi_pathogen_*`): a curated, deduplicated index of bacterial isolates with computed
antimicrobial-resistance genotypes. **Prefer it for any question about resistance genes or resistant strains.** It
answers those from curated AMR calls, whereas the E-utilities databases can only match free-text sample descriptions,
searching BioSample for 'MRSA' finds the isolates whose submitter happened to use that word, which undercounts
severalfold. Use ncbi_pathogen_organisms and ncbi_pathogen_amr_genes to get exact filter values first: values are
matched literally, and an unrecognized one returns 0 rather than an error, so a typo is indistinguishable from a real
negative.

Every result carries a `provenance` block. Read it before answering, and cite it:
- `sources`: which databases produced the data, and each one's share of the result.
- `request_cost`: how many NCBI requests this answer spent.
- `coverage`: the result count against a denominator, with `basis` naming what the denominator counts. Report the
  percentage and the basis together; a count without its denominator reads as a population. A `shortfall` means NCBI
  silently dropped records you asked for.
- `query_translation`: the query NCBI actually ran, which is often not the one that was sent. Report it when it
  differs from the request. Absent on Pathogen Detection record fetches, which cannot return it and rows together.
- `notes`: caveats that change how a number should be read. The Pathogen Detection tools use these to flag that raw
  row counts are about twice the isolate count.

Results may be truncated. When `truncated` is true, `next` holds the parameters for the following page; do not describe
a truncated result as complete.

### PubMed (`pubmed_*`)

Search PubMed literature and fetch article detail, batch summaries, and related-article links (similar, citing,
references, reviews) through NCBI's E-utilities.

### GEO (`geo_*`)

NCBI GEO for gene expression studies: find Series by organism and treatment, read one study's metadata and samples,
and locate the supplementary files that hold the processed expression values. GEO is the only source here with
expression data. Resolve GEO accessions with geo_resolve_accession rather than by searching for them.

### NIAID Data Ecosystem (`nde_*`)

Search the NIAID Data Ecosystem Discovery Portal: ~14M federated metadata records for biomedical datasets, samples,
computational tools, and resource catalogs from NCBI, Zenodo, Figshare, PDB, bio.tools, dbGaP, ImmPort and more.

Typical flow:
  1. nde_search_datasets for keyword + filter search over datasets.
  2. nde_semantic_search when the user's phrasing is conversational and keyword matching is likely to miss.
  3. nde_search_tools for software and analysis workflows.
  4. nde_facet_counts to discover which filter values exist before filtering, or to summarize the landscape of a topic.
  5. nde_get_record to pull the full metadata for a promising hit.

Every result carries its source repository and both a source URL and a portal URL, so findings stay traceable. Use
nde_list_repositories to see which repositories are federated and how many records each contributes.

### BRC Analytics (`brc_ena_*`)

Sequencing-data tools for BRC Analytics, complementing the public BRC Analytics MCP server rather than duplicating it.
Use the federated BRC tools (search_organisms, get_assemblies, check_compatibility, ...) for the genome catalog and
workflow compatibility. Use these tools for raw sequencing runs in ENA: real totals, paging past 50 results, keyword
search, and study lookup. show_brc_workflow_matrix shows the user which workflows can run on which assemblies of an
organism.

### STRING (`show_string_network`)

Show STRING protein-protein interaction networks to the user in an interactive graph, for a list of proteins or one
protein and its top partners. Use the tools of the STRING server for text answers."""

mcp = MCPServer(name="pdn", title="Pathogen Data Network", instructions=INSTRUCTIONS, extensions=[apps])
