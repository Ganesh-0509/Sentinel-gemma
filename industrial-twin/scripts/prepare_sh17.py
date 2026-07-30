"""Build a YOLO training set from SH17 labels + Pexels imagery.

Labels come from `scripts/fetch_sh17_labels.py` (ranged fetch, no 14 GB
download). Images come from the same public Pexels URLs the dataset itself
distributes, so nothing here needs a Kaggle token.

Class selection
---------------
SH17 has 17 classes, but most are body parts (ear, face, hands, foot) that the
safety pipeline has no use for. We keep the ones that answer an operational
question:

    person       -> occupancy, which drives exposure ranking
    helmet       -> PPE compliance
    safety-vest  -> PPE compliance
    gloves       -> PPE compliance
    head         -> a head with no helmet is the actual violation signal

Keeping the set small matters on CPU: fewer classes converge faster, and the
rare-class problem is severe here (helmet appears 927 times against 15,850 for
hands).

Image selection is biased toward frames that actually contain PPE, because a
training set dominated by PPE-free images teaches the model to predict nothing.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import random
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

LABEL_DIR = ROOT / "data" / "external" / "sh17_labels"
OUT = ROOT / "data" / "external" / "sh17_yolo"
URL_LIST = ("https://raw.githubusercontent.com/ahmadmughees/sh17dataset/"
            "master/data/list_of_all_urls.csv")
UA = "SentinelAI/0.1 (industrial-safety research)"

# SH17 class id -> our id. Everything else is dropped.
KEEP = {0: 0, 10: 1, 16: 2, 9: 3, 12: 4}
NAMES = ["person", "helmet", "safety-vest", "gloves", "head"]
# Classes whose presence makes an image worth training on.
PPE_SOURCE_IDS = {10, 16, 9}


def load_urls() -> dict[str, str]:
    req = urllib.request.Request(URL_LIST, headers={"User-Agent": UA})
    txt = urllib.request.urlopen(req, timeout=90).read().decode("utf-8", "replace")
    out = {}
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        out[Path(line.split("?")[0]).stem] = line
    return out


def convert(label_path: Path) -> tuple[list[str], bool]:
    """Remap a label file to our class set. Returns (lines, contains_ppe)."""
    lines, has_ppe = [], False
    for raw in label_path.read_text().splitlines():
        parts = raw.split()
        if len(parts) != 5:
            continue
        cid = int(parts[0])
        if cid in PPE_SOURCE_IDS:
            has_ppe = True
        if cid in KEEP:
            lines.append(" ".join([str(KEEP[cid])] + parts[1:]))
    return lines, has_ppe


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--images", type=int, default=700, help="images to fetch")
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--width", type=int, default=960, help="Pexels resize width")
    ap.add_argument("--seed", type=int, default=20260720)
    args = ap.parse_args()

    if not LABEL_DIR.exists():
        print("no labels; run scripts/fetch_sh17_labels.py first")
        return 1

    print("[1/4] Reading labels ...")
    converted: dict[str, list[str]] = {}
    ppe_stems, plain_stems = [], []
    for p in sorted(LABEL_DIR.glob("*.txt")):
        lines, has_ppe = convert(p)
        if not lines:
            continue
        converted[p.stem] = lines
        (ppe_stems if has_ppe else plain_stems).append(p.stem)
    print(f"      usable labels: {len(converted):,} "
          f"({len(ppe_stems):,} contain PPE)")

    print("[2/4] Resolving image URLs ...")
    urls = load_urls()
    ppe_stems = [s for s in ppe_stems if s in urls]
    plain_stems = [s for s in plain_stems if s in urls]
    print(f"      matched to URLs: {len(ppe_stems):,} PPE / {len(plain_stems):,} other")

    # Bias hard toward PPE-bearing frames; keep some plain ones as negatives.
    rng = random.Random(args.seed)
    rng.shuffle(ppe_stems)
    rng.shuffle(plain_stems)
    n_ppe = min(len(ppe_stems), int(args.images * 0.8))
    n_plain = min(len(plain_stems), args.images - n_ppe)
    chosen = ppe_stems[:n_ppe] + plain_stems[:n_plain]
    rng.shuffle(chosen)
    n_val = max(1, int(len(chosen) * args.val_frac))
    splits = {"val": chosen[:n_val], "train": chosen[n_val:]}
    print(f"      selected {len(chosen)} images "
          f"(train {len(splits['train'])}, val {len(splits['val'])})")

    for sp in splits:
        (OUT / "images" / sp).mkdir(parents=True, exist_ok=True)
        (OUT / "labels" / sp).mkdir(parents=True, exist_ok=True)

    print("[3/4] Downloading images ...")

    def fetch(item):
        stem, split = item
        dst = OUT / "images" / split / f"{stem}.jpg"
        if dst.exists() and dst.stat().st_size > 0:
            return True
        url = f"{urls[stem]}?auto=compress&cs=tinysrgb&w={args.width}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            dst.write_bytes(urllib.request.urlopen(req, timeout=60).read())
            return True
        except Exception:
            return False

    jobs = [(s, sp) for sp, stems in splits.items() for s in stems]
    with cf.ThreadPoolExecutor(12) as ex:
        ok = list(ex.map(fetch, jobs))
    print(f"      downloaded {sum(ok)}/{len(jobs)}")

    print("[4/4] Writing labels + data.yaml ...")
    counts = collections.Counter()
    kept = 0
    for stem, split in jobs:
        img = OUT / "images" / split / f"{stem}.jpg"
        if not img.exists() or img.stat().st_size == 0:
            continue
        lines = converted[stem]
        (OUT / "labels" / split / f"{stem}.txt").write_text("\n".join(lines))
        kept += 1
        for line in lines:
            counts[int(line.split()[0])] += 1

    yaml = (f"path: {OUT.as_posix()}\n"
            f"train: images/train\n"
            f"val: images/val\n\n"
            f"names:\n"
            + "".join(f"  {i}: {n}\n" for i, n in enumerate(NAMES)))
    (OUT / "data.yaml").write_text(yaml)

    print(f"      {kept} image/label pairs")
    for i, n in enumerate(NAMES):
        print(f"        {i} {n:12s} {counts[i]:6,}")
    print(f"      wrote {(OUT / 'data.yaml').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
