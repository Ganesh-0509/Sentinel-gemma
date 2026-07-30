"""Fetch SH17 YOLO labels without downloading the 14 GB archive.

The SH17 images are freely available as Pexels URLs, but the annotation labels
ship only inside the Kaggle archive -- which is 14,096,291,832 bytes, almost all
of it high-resolution imagery we do not need (we already have a working image
sample, downloaded from the same Pexels URLs the dataset itself uses).

A ZIP file stores its central directory at the *end*, and Kaggle's storage
backend honours HTTP Range requests (verified: 206 Partial Content). So the
archive can be opened remotely: read the tail to get the file index, then pull
only the label entries -- a few MB of plain text instead of 14 GB.

Usage:
    python scripts/fetch_sh17_labels.py            # labels only
    python scripts/fetch_sh17_labels.py --limit 0  # every label
"""
from __future__ import annotations

import argparse
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

URL = ("https://www.kaggle.com/api/v1/datasets/download/"
       "mugheesahmad/sh17-dataset-for-ppe-detection")
OUT_DIR = ROOT / "data" / "external" / "sh17_labels"
UA = "SentinelAI/0.1 (industrial-safety research)"


class HTTPRangeFile(io.RawIOBase):
    """A seekable read-only file backed by HTTP Range requests.

    Only the bytes actually read are transferred, which is what makes opening a
    14 GB remote archive practical.
    """

    def __init__(self, url: str, timeout: int = 120):
        self.url = url
        self.timeout = timeout
        self._pos = 0
        self._size = self._probe_size()
        self.bytes_fetched = 0
        self.requests = 0
        # Optional contiguous cache: (start, bytes). The label entries sit in a
        # single ~6 MB run at the end of the archive, so prefetching that span
        # turns 8,101 range requests into one.
        self._cache: tuple[int, bytes] | None = None

    def prefetch(self, start: int, end: int) -> None:
        """Pull [start, end) once and serve subsequent reads from memory."""
        start = max(0, start)
        end = min(self._size, end)
        if end <= start:
            return
        req = urllib.request.Request(
            self.url,
            headers={"User-Agent": UA, "Range": f"bytes={start}-{end - 1}"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = r.read()
        self.requests += 1
        self.bytes_fetched += len(data)
        self._cache = (start, data)

    def _probe_size(self) -> int:
        req = urllib.request.Request(
            self.url, headers={"User-Agent": UA, "Range": "bytes=0-1"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            cr = r.headers.get("Content-Range", "")
            if "/" not in cr:
                raise RuntimeError(f"server does not support ranges: {cr!r}")
            return int(cr.rsplit("/", 1)[1])

    # --- io plumbing ---
    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self._pos = offset
        elif whence == io.SEEK_CUR:
            self._pos += offset
        elif whence == io.SEEK_END:
            self._pos = self._size + offset
        return self._pos

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = self._size - self._pos
        if size == 0 or self._pos >= self._size:
            return b""
        stop = min(self._pos + size, self._size)

        # Serve from the prefetched span when it fully covers the request.
        if self._cache is not None:
            c_start, blob = self._cache
            c_end = c_start + len(blob)
            if c_start <= self._pos and stop <= c_end:
                data = blob[self._pos - c_start:stop - c_start]
                self._pos += len(data)
                return data

        req = urllib.request.Request(
            self.url,
            headers={"User-Agent": UA, "Range": f"bytes={self._pos}-{stop - 1}"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = r.read()
        self.requests += 1
        self._pos += len(data)
        self.bytes_fetched += len(data)
        return data

    def readinto(self, b) -> int:
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=0,
                    help="max labels to extract (0 = all)")
    args = ap.parse_args()

    print(f"[1/3] Opening remote archive via HTTP ranges ...")
    raw = HTTPRangeFile(URL)
    print(f"      archive size: {raw._size / 1e9:.2f} GB (not downloading it)")

    zf = zipfile.ZipFile(io.BufferedReader(raw, buffer_size=1 << 20))
    infos = zf.infolist()
    print(f"      entries in archive: {len(infos):,}")

    labels = [i for i in infos if i.filename.lower().endswith(".txt")
              and "label" in i.filename.lower()]
    if not labels:
        labels = [i for i in infos if i.filename.lower().endswith(".txt")]
    print(f"[2/3] Label entries found: {len(labels):,}")
    if not labels:
        print("      no .txt entries; archive layout may have changed")
        for i in infos[:15]:
            print("       ", i.filename)
        return 1

    sel = labels if args.limit in (0, None) else labels[:args.limit]

    # The labels form one contiguous run near the end of the archive. Pull the
    # whole span in a single request instead of one per file.
    lo = min(i.header_offset for i in sel)
    hi = max(i.header_offset + i.compress_size + len(i.filename) + 256
             for i in sel)
    print(f"      label span: {(hi - lo) / 1e6:.1f} MB -- fetching in one request")
    raw.prefetch(lo, hi)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for info in sel:
        (OUT_DIR / Path(info.filename).name).write_bytes(zf.read(info))
        written += 1

    print(f"[3/3] Wrote {written:,} label files to "
          f"{OUT_DIR.relative_to(ROOT)}")
    print(f"      transferred {raw.bytes_fetched / 1e6:.1f} MB in "
          f"{raw.requests} requests "
          f"(vs {raw._size / 1e9:.1f} GB for the full archive)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
