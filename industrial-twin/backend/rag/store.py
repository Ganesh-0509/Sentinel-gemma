"""Regulation retrieval store.

Chunks the regulation corpus by heading, indexes it, and retrieves the passages
most relevant to a question -- carrying **provenance** through to every citation so
the UI can mark whether an answer rests on official text or a development summary.

Retrieval backend:
    * default  -- TF-IDF + cosine similarity (sklearn). Zero extra downloads,
      deterministic, and strong on this corpus because regulatory queries are
      keyword-dense ("hot work", "%LEL", "confined space", "oxygen").
    * optional -- Ollama embeddings, if a local embedding model is pulled.
      Set SENTINEL_EMBED=ollama to enable.

A vector database (FAISS/Chroma) is unnecessary at this corpus size; cosine over a
few hundred chunks is sub-millisecond. Swap it in when the corpus grows.
"""
from __future__ import annotations

import json
import logging
import os
import re
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

log = logging.getLogger("sentinel.rag")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("SENTINEL_EMBED_MODEL", "nomic-embed-text")

# Rank weighting for our own plant procedure.
#
# The SOP describes how *this system* works. It is a legitimate source for "what
# does SentinelAI do", and a poor one for "what does the law require" -- but it
# is written in the same vocabulary as the questions the workflow generates, so
# TF-IDF favoured it heavily and regulatory answers ended up grounded in our own
# description of ourselves. Circular, and exactly what made answers read as
# generic. Weighting it below the standards means it still wins when it is
# genuinely the best source, and loses a close contest to actual regulation.
INTERNAL_SOP_WEIGHT = 0.70

# Two thresholds, because one cannot do the job.
#
# TF-IDF cosine over a 35-chunk corpus does not cleanly separate a weak-but-real
# match from incidental word overlap: "when must an accident be reported to the
# regulator" scores 0.070 against the Factories Act section that answers it
# exactly (the corpus says "Inspector", the question says "regulator"), while
# "share price of Tata Steel" scores 0.087 against "About the DGMS". A single
# cut-off either admits the noise or discards the real answer.
#
# So: RETRIEVAL_FLOOR decides whether a passage is worth showing at all, and
# CONFIDENT_RELEVANCE decides whether the result may be *presented as* grounded.
# Between them the assistant answers, cites, and flags the match as weak -- and
# the system prompt already instructs it to say when the passages do not cover
# the question.
RETRIEVAL_FLOOR = 0.05
CONFIDENT_RELEVANCE = 0.10

# Backwards-compatible alias; `search()` still takes an explicit override.
MIN_RELEVANCE = RETRIEVAL_FLOOR


@dataclass
class Chunk:
    text: str
    doc_title: str
    standard: str
    section: str
    provenance: str          # OFFICIAL | STATUTE | SUMMARY | REFERENCE_ONLY
    source_file: str
    # REGULATION -- a standard or statute. INTERNAL -- our own plant procedure.
    kind: str = "REGULATION"
    score: float = 0.0

    def citation(self) -> str:
        mark = "" if self.provenance == "OFFICIAL" else " [development summary — not official text]"
        return f"{self.standard} — {self.section}{mark}"


def _parse_front_matter(raw: str) -> tuple[dict, str]:
    """Split YAML-ish front matter from the body.

    Leading whitespace and a UTF-8 BOM are tolerated. They were not before, and
    a single blank line above the `---` in one corpus file was enough to make
    the whole block parse as *body text*: that document lost its title,
    standard and provenance, was cited by its filename, was silently downgraded
    to SUMMARY, and its raw YAML was indexed as a retrievable passage.
    """
    body = raw.lstrip("﻿").lstrip()
    meta: dict = {}
    if body.startswith("---"):
        end = body.find("\n---", 3)
        if end != -1:
            for line in body[3:end].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = body[end + 4:]
    return meta, body


def _split_sections(body: str) -> list[tuple[str, str]]:
    """Split markdown into (heading, text) pairs on ## headings."""
    parts = re.split(r"\n##+\s+", "\n" + body)
    out = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        lines = part.splitlines()
        heading = lines[0].strip().lstrip("# ").strip()
        text = "\n".join(lines[1:]).strip()
        if text:
            out.append((heading, text))
    return out


class RegulationStore:
    """Loads the public corpus plus any licensed documents held locally.

    `data/regulations`       committed: statutes and our own SOPs.
    `data/regulations_local` git-ignored: restricted-circulation standards (e.g.
                             OISD-STD-105) that must not enter version control.
                             Present on the operator's machine only.
    """

    def __init__(self, corpus_dir: str | Path = "data/regulations",
                 local_dir: str | Path = "data/regulations_local"):
        self.corpus_dir = Path(corpus_dir)
        self.local_dir = Path(local_dir)
        self.chunks: list[Chunk] = []
        self._matrix = None
        self._vectorizer: TfidfVectorizer | None = None
        self._embeddings: np.ndarray | None = None
        self.backend = "tfidf"

    # ------------------------------------------------------------------ build
    def build(self) -> "RegulationStore":
        paths = list(self.corpus_dir.glob("*.md"))
        if self.local_dir.exists():
            paths += list(self.local_dir.glob("*.md")) + list(self.local_dir.glob("*.txt"))
        for path in sorted(paths):
            if path.name.lower() == "readme.md":
                continue
            meta, body = _parse_front_matter(path.read_text(encoding="utf-8"))
            # Say so rather than defaulting in silence. A document indexed under
            # its filename with a guessed provenance is a citation nobody can
            # check, and it is invisible unless someone reads the chunk list.
            if not meta:
                log.warning(
                    "%s has no front matter: indexing it under its filename with "
                    "provenance SUMMARY. Add title/standard/provenance to cite it "
                    "properly.", path.name,
                )
            # anything supplied locally is the operator's licensed copy
            if self.local_dir in path.parents:
                meta.setdefault("provenance", "OFFICIAL")
            for heading, text in _split_sections(body):
                self.chunks.append(Chunk(
                    text=text,
                    doc_title=meta.get("title", path.stem),
                    standard=meta.get("standard", path.stem),
                    section=heading,
                    provenance=meta.get("provenance", "SUMMARY").upper(),
                    kind=meta.get("kind", "REGULATION").upper(),
                    source_file=path.name,
                ))
        if not self.chunks:
            raise FileNotFoundError(f"no regulation documents found in {self.corpus_dir}")

        corpus = [f"{c.standard} {c.section}. {c.text}" for c in self.chunks]
        if os.environ.get("SENTINEL_EMBED") == "ollama":
            emb = self._embed_all(corpus)
            if emb is not None:
                self._embeddings, self.backend = emb, f"ollama:{EMBED_MODEL}"
                return self
        self._vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2),
                                           sublinear_tf=True)
        self._matrix = self._vectorizer.fit_transform(corpus)
        return self

    # -------------------------------------------------------------- embeddings
    def _embed_one(self, text: str) -> np.ndarray | None:
        payload = {"model": EMBED_MODEL, "prompt": text}
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/embeddings",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.asarray(json.loads(r.read().decode())["embedding"], dtype=float)
        except Exception:
            return None

    def _embed_all(self, texts: list[str]) -> np.ndarray | None:
        vecs = []
        for t in texts:
            v = self._embed_one(t)
            if v is None:
                return None
            vecs.append(v)
        return np.vstack(vecs)

    # --------------------------------------------------------------- retrieve
    def search(self, query: str, k: int = 4,
               min_relevance: float = MIN_RELEVANCE) -> list[Chunk]:
        """Top-k passages above the relevance floor, regulation preferred.

        Two deliberate departures from raw cosine ranking:

        * **The floor.** Previously anything with similarity > 0 was returned
          and the assistant reported it as grounded, so an off-topic question
          got a confident answer built on a passage that shared one common word.
          The console already told the operator a threshold existed; now one
          does.
        * **The internal-SOP weighting.** See `INTERNAL_SOP_WEIGHT`.

        The floor is applied to the *raw* similarity, not the weighted score, so
        down-weighting the SOP can reorder results but can never suppress a
        passage that was genuinely relevant.
        """
        if self._embeddings is not None:
            qv = self._embed_one(query)
            if qv is not None:
                sims = cosine_similarity(qv.reshape(1, -1), self._embeddings)[0]
            else:
                sims = np.zeros(len(self.chunks))
        else:
            qv = self._vectorizer.transform([query])
            sims = cosine_similarity(qv, self._matrix)[0]

        ranked = [
            (float(sims[i]) * (INTERNAL_SOP_WEIGHT if c.kind == "INTERNAL" else 1.0),
             float(sims[i]), c)
            for i, c in enumerate(self.chunks)
            if float(sims[i]) >= min_relevance
        ]
        ranked.sort(key=lambda t: t[0], reverse=True)
        # Report the true similarity, not the ranking weight -- the score shown
        # in the console should mean "how well this passage matches".
        return [Chunk(**{**c.__dict__, "score": raw}) for _, raw, c in ranked[:k]]
