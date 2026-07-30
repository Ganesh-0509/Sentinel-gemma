# Regulation corpus

Documents here are indexed by `sentinel.rag.store.RegulationStore` and cited by the
compliance assistant. This README is skipped by the loader.

## Provenance is not decoration

Every chunk carries a `provenance` field from its front matter:

| Value | Meaning | Citation rendering |
|---|---|---|
| `OFFICIAL` | Verbatim authoritative text, or our own plant SOP | cited plainly |
| `STATUTE` | Verbatim statutory text | cited plainly |
| `SUMMARY` | A paraphrase written for development | cited with `[development summary — not official text]` |
| `REFERENCE_ONLY` | Pointer to a document we do not hold | cited with the same marker |

**The regulatory files in this directory are `SUMMARY`.** They paraphrase the
principles and thresholds these standards establish so the retrieval pipeline has
real material to work against. They are *not* reproductions of the standards, and
they deliberately avoid asserting specific clause numbers — a paraphrase attached
to a fabricated clause number is worse than no citation at all.

The assistant's system prompt already forbids inventing clause numbers, and the UI
badges anything non-official. Do not "upgrade" a summary's provenance to make the
badge look better in a demo.

## Using the real standards

OISD-STD-105 is a restricted-circulation standard and must not be committed to this
repository. If your site holds a licensed copy:

1. Create `data/regulations_local/` (git-ignored).
2. Drop the `.md` or `.txt` extract in.
3. Restart the API.

Anything loaded from `regulations_local/` is marked `OFFICIAL` automatically and
takes precedence in citations. The Factories Act 1948 is public and its official
text may be added the same way.

## Sources

- OISD-STD-105 — Work Permit System, Oil Industry Safety Directorate (India)
- The Factories Act 1948 — Chapter IV-A, hazardous processes (Government of India)
- DGMS circulars — Directorate General of Mines Safety (India)
