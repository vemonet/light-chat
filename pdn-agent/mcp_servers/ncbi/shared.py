"""Clients and filters shared by the NCBI tools of `server.py` and the widget tools of `apps.py`.

Kept apart so both modules import them without a cycle: the server needs the widget tools at construction.
There is one client per service for the whole process, they share one rate limiter (see `server.py`).
"""

from __future__ import annotations

import re

from . import pathogens
from .eutils import EUtilsClient
from .pathogens import PathogensClient

client = EUtilsClient()

# A second service, deliberately sharing the first one's limiter. NCBI's rate
# limit is per IP address and applies across its services, so two independently
# paced clients in one process would each believe they had the whole 3/sec
# budget and together spend six.
pathogen_client = PathogensClient(client.limiter, client.email)


def pathogen_filter(
    organism: str | None,
    amr_genes: str | list[str] | None,
    host: str | None,
    isolation_source: str | None,
    epi_type: str | None,
) -> tuple[str | None, dict[str, list[str]]]:
    """Pathogen Detection `fq` filter and its clauses, AMR genes given as a list or separated by commas or spaces"""
    clauses: dict[str, list[str]] = {}
    if organism:
        clauses["taxgroup_name"] = [organism]
    genes = re.split(r"[,\s]+", amr_genes) if isinstance(amr_genes, str) else amr_genes or []
    if genes := [g.strip() for g in genes if g.strip()]:
        clauses["AMR_genotypes"] = genes
    if host:
        clauses["host"] = [host]
    if isolation_source:
        clauses["isolation_source"] = [isolation_source]
    if epi_type:
        clauses["epi_type"] = [epi_type]
    return pathogens.build_fq(clauses), clauses
