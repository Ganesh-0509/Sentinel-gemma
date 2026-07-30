"""Fine-tune a YOLO detector for PPE compliance on the SH17 subset.

Run `scripts/fetch_sh17_labels.py` then `scripts/prepare_sh17.py` first.

Notes on the settings
---------------------
* CPU-only on this machine, so the model is `yolo11n` (nano) at a reduced image
  size. The point is a working, honestly-evaluated detector -- not a
  state-of-the-art one.
* `plots=False` is required, not cosmetic: ultralytics renders training plots
  with matplotlib, whose native DLL is blocked by machine policy here.
* Seeded for reproducibility, matching the rest of the project.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DATA = ROOT / "data" / "external" / "sh17_yolo" / "data.yaml"
OUT_DIR = ROOT / "models" / "vision"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--imgsz", type=int, default=512)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--model", default="yolo11n.pt")
    args = ap.parse_args()

    if not DATA.exists():
        print(f"missing {DATA}; run scripts/prepare_sh17.py first")
        return 1

    # Import through the project's vision layer so the scoped matplotlib stub
    # is applied consistently.
    from sentinel.vision.detector import VISION_AVAILABLE, _matplotlib_stub

    if not VISION_AVAILABLE:
        print("vision stack unavailable; pip install '.[vision]'")
        return 1

    with _matplotlib_stub():
        from ultralytics import YOLO

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        model = YOLO(args.model)
        print(f"Training {args.model} on {DATA.parent.name} "
              f"({args.epochs} epochs, imgsz={args.imgsz}, CPU)")
        model.train(
            data=str(DATA),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            device="cpu",
            project=str(OUT_DIR),
            name="ppe",
            exist_ok=True,
            plots=False,      # matplotlib DLL blocked by machine policy
            seed=20260720,
            verbose=True,
            val=True,
        )
        best = OUT_DIR / "ppe" / "weights" / "best.pt"
        print(f"\nbest weights: {best}")
        print("exists:", best.exists())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
