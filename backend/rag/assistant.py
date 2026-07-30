"""Compliance assistant: retrieve -> ground -> answer with citations.

Hard rule: the assistant answers **only** from retrieved passages. If retrieval
returns nothing relevant, it says so rather than answering from model memory --
a confidently wrong regulatory answer is worse than no answer.
"""
from __future__ import annotations

from dataclasses import dataclass

from sentinel.llm.provider import LLMUnavailable, get_llm
from sentinel.rag.store import CONFIDENT_RELEVANCE, Chunk, RegulationStore

SYSTEM = (
    "You are an industrial safety compliance assistant for an Indian heavy-industry "
    "plant. Answer ONLY from the provided reference passages. If the passages do not "
    "cover the question, say so plainly and do not speculate. Be concise and direct: "
    "lead with the operational answer (what must happen), then the reasoning. Never "
    "invent clause numbers or quote text that is not in the passages."
)


@dataclass
class ComplianceAnswer:
    question: str
    answer: str
    citations: list[str]
    chunks: list[Chunk]
    backend: str
    grounded: bool
    # How well the corpus actually covered the question:
    #   none -- nothing cleared the retrieval floor; no answer was attempted.
    #   low  -- something was retrieved, but weakly, or only from our own SOP.
    #           The answer is shown with that caveat rather than suppressed.
    #   high -- a regulatory passage matched confidently.
    confidence: str = "high"

    def as_dict(self) -> dict:
        return {
            "question": self.question,
            "answer": self.answer,
            "citations": self.citations,
            "backend": self.backend,
            "grounded": self.grounded,
            "confidence": self.confidence,
        }


class ComplianceAssistant:
    def __init__(self, store: RegulationStore | None = None, prefer: str | None = None):
        self.store = store or RegulationStore().build()
        self.llm = get_llm(prefer=prefer)

    def ask(self, question: str, k: int = 4) -> ComplianceAnswer:
        chunks = self.store.search(question, k=k)
        citations = []
        seen = set()
        for c in chunks:
            cite = c.citation()
            if cite not in seen:
                seen.add(cite)
                citations.append(cite)

        if not chunks:
            # Nothing cleared the relevance floor in the store. Declining is the
            # correct answer: a confidently wrong regulatory answer is worse
            # than none, and the corpus is small enough that "not in here" is a
            # perfectly ordinary outcome.
            return ComplianceAnswer(
                question=question,
                answer=("No passage in the regulation corpus was relevant enough to answer "
                        "this from source, so I am not going to answer it from model "
                        "memory. The corpus covers work permits and gas testing "
                        "(OISD-STD-105), hazardous-process duties and accident reporting "
                        "(Factories Act 1948), gas testing and withdrawal of persons "
                        "(DGMS), and this plant's own SOP. Escalate to the safety officer "
                        "if the question falls outside those."),
                citations=[], chunks=[], backend=self.llm.backend, grounded=False,
                confidence="none",
            )

        # Grounding is about the *regulatory* question being answerable from a
        # standard. Our own SOP describes this system, so an answer resting only
        # on it is grounded in a description of ourselves -- reported honestly
        # rather than badged as regulatory grounding.
        regulatory = [c for c in chunks if c.kind != "INTERNAL"]
        confident = [c for c in regulatory if c.score >= CONFIDENT_RELEVANCE]
        confidence = "high" if confident else "low"

        context = "\n\n".join(
            f"[{i+1}] {c.standard} — {c.section}\n{c.text}" for i, c in enumerate(chunks)
        )
        # Tell the model when retrieval was weak. Without this it receives four
        # passages and no signal that they are marginal, so it stretches them to
        # fit -- which is how a question the corpus does not cover comes back as
        # a confident, cited-looking answer.
        weak = ("\n\nNOTE: none of these passages matched the question strongly. If they "
                "do not actually address it, say so plainly rather than stretching them "
                "to fit." if confidence == "low" else "")
        prompt = (
            f"Reference passages:\n\n{context}\n\n"
            f"Question: {question}{weak}\n\n"
            "Answer using only the passages above. Cite the passages you rely on by "
            "their standard and section name."
        )

        backend = self.llm.backend
        try:
            answer = self.llm.generate(prompt, system=SYSTEM)
        except LLMUnavailable as e:
            # Extractive degradation: return the source text itself.
            #
            # Report the backend that actually produced this answer, not the one
            # we hoped to use. Labelling verbatim source text as an "ollama"
            # answer made a degraded response look like a generated one, so an
            # operator had no way to tell that the language model had dropped
            # out underneath them.
            top = chunks[0]
            backend = f"extractive (fallback: {e})"
            answer = ("[No language model available -- returning the most relevant source "
                      f"passage verbatim.]\n\n{top.standard} -- {top.section}:\n{top.text}")

        return ComplianceAnswer(
            question=question, answer=answer.strip(), citations=citations,
            chunks=chunks, backend=backend, grounded=bool(confident),
            confidence=confidence,
        )
