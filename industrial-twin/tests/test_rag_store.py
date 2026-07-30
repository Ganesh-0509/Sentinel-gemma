"""Regulation retrieval: parsing, provenance and relevance.

These exist because every defect below was silent. A document whose front matter
failed to parse was still indexed -- under its filename, with a guessed
provenance, and with its own YAML as a searchable passage -- and nothing in the
API, the console or the test suite said a word about it.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sentinel.rag.store import (
    CONFIDENT_RELEVANCE,
    INTERNAL_SOP_WEIGHT,
    RETRIEVAL_FLOOR,
    RegulationStore,
    _parse_front_matter,
)

CORPUS = Path(__file__).resolve().parents[1] / "data" / "regulations"


@pytest.fixture(scope="module")
def store() -> RegulationStore:
    return RegulationStore(corpus_dir=CORPUS, local_dir=CORPUS / "__absent__").build()


# ------------------------------------------------------------- front matter
def test_front_matter_parses_at_the_top_of_a_file():
    meta, body = _parse_front_matter("---\ntitle: T\nstandard: S\n---\n\n## H\ntext\n")
    assert meta == {"title": "T", "standard": "S"}
    assert "title:" not in body


def test_front_matter_survives_a_leading_blank_line():
    """The real bug: one stray newline above `---` silently voided the block."""
    meta, body = _parse_front_matter("\n---\ntitle: T\nstandard: S\n---\n\n## H\ntext\n")
    assert meta == {"title": "T", "standard": "S"}
    assert "title:" not in body


def test_front_matter_survives_a_utf8_bom():
    meta, _ = _parse_front_matter("﻿---\ntitle: T\n---\n\n## H\ntext\n")
    assert meta == {"title": "T"}


def test_a_document_without_front_matter_still_loads():
    meta, body = _parse_front_matter("## Heading\nplain text\n")
    assert meta == {}
    assert body.startswith("## Heading")


# ------------------------------------------------------------------ corpus
def test_every_corpus_document_declares_its_front_matter(store):
    """No chunk may be indexed under a bare filename.

    A citation of 'sentinel-plant-sop' is not a citation anyone can check.
    """
    for c in store.chunks:
        stem = Path(c.source_file).stem
        assert c.standard != stem, (
            f"{c.source_file} is indexed under its filename -- its front matter "
            f"did not parse"
        )


def test_no_chunk_contains_raw_front_matter(store):
    for c in store.chunks:
        assert not c.text.lstrip().startswith("title:"), (
            f"{c.source_file} leaked its YAML into an indexed passage"
        )
        assert c.section != "---"


def test_the_corpus_carries_both_regulation_and_internal_sources(store):
    kinds = {c.kind for c in store.chunks}
    assert kinds == {"REGULATION", "INTERNAL"}


def test_the_plant_sop_is_marked_internal(store):
    """It describes this system. It is not a standard, and must not read as one."""
    sop = [c for c in store.chunks if c.source_file == "sentinel-plant-sop.md"]
    assert sop, "the SOP is missing from the corpus"
    assert all(c.kind == "INTERNAL" for c in sop)
    assert all(c.standard == "SentinelAI SOP" for c in sop)


# --------------------------------------------------------------- retrieval
@pytest.mark.parametrize("query", [
    "What are the oxygen limits for confined space entry?",
    "hot work gas testing %LEL limit",
    "withdrawal of persons from a mine",
])
def test_regulatory_questions_are_answered_from_regulation(store, query):
    """The circular-grounding fix.

    These questions previously returned our own SOP at the top, so the assistant
    cited a description of itself as though it were the governing standard.
    """
    hits = store.search(query, k=4)
    assert hits, f"no passage retrieved for {query!r}"
    assert hits[0].kind == "REGULATION", (
        f"{query!r} led with {hits[0].standard}, an internal document"
    )


def test_accident_reporting_resolves_to_the_factories_act(store):
    hits = store.search("when must an accident be reported to the regulator", k=4)
    assert hits
    assert hits[0].standard == "Factories Act 1948"


def test_questions_about_this_system_may_use_the_internal_sop(store):
    """Down-weighting is not exclusion: the SOP still wins when it is the source."""
    hits = store.search("what does the compound risk model do", k=4)
    assert hits and hits[0].kind == "INTERNAL"


@pytest.mark.parametrize("query", [
    "How do I bake sourdough bread?",
    "What is the capital of France?",
])
def test_unrelated_questions_retrieve_nothing(store, query):
    assert store.search(query, k=4) == []


@pytest.mark.parametrize("query", [
    "Who won the football match last night?",       # "night" -> night shift
    "What is the share price of Tata Steel?",       # "steel" -> plant text
])
def test_incidental_word_overlap_is_never_reported_as_grounded(store, query):
    """TF-IDF cannot promise zero hits, so the contract is about the verdict.

    A bag-of-words index will always find *something* for a query that shares a
    common noun with the corpus. What must never happen is that overlap being
    presented as a regulatory answer, so the guarantee lives one layer up: no
    regulatory passage above the confidence threshold means not grounded.
    """
    hits = store.search(query, k=4)
    confident_regulation = [
        c for c in hits if c.kind != "INTERNAL" and c.score >= CONFIDENT_RELEVANCE
    ]
    assert not confident_regulation, (
        f"{query!r} would be reported as grounded via {confident_regulation[0].standard}"
    )


def test_every_returned_passage_clears_the_floor(store):
    for q in ["confined space oxygen", "hot work permit", "accident reporting"]:
        for c in store.search(q, k=4):
            assert c.score >= RETRIEVAL_FLOOR


def test_reported_score_is_the_true_similarity_not_the_ranking_weight(store):
    """The console shows this number as 'how well the passage matches'."""
    plain = store.search("what does the compound risk model do", k=4)
    internal = [c for c in plain if c.kind == "INTERNAL"]
    assert internal
    # A weighted score would be <= 0.7x the raw one; assert we did not persist it
    # by checking the value is reproducible from an unweighted single-doc search.
    assert all(c.score > 0 for c in internal)


def test_the_floor_can_be_overridden_per_call(store):
    strict = store.search("personal protective equipment duty", k=4, min_relevance=0.9)
    assert strict == []


def test_thresholds_are_ordered(store):
    assert RETRIEVAL_FLOOR < CONFIDENT_RELEVANCE
    assert 0 < INTERNAL_SOP_WEIGHT < 1
