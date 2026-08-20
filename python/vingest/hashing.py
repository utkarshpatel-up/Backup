"""Content digests for bit-exact verification.

xxhash when it is installed (several times faster than any crypto hash, and
these are integrity checks, not security ones); blake2b from the stdlib
otherwise, so the app never hard-depends on a wheel being present.
"""

from __future__ import annotations

from pathlib import Path

try:
    import xxhash

    _ALGO = "xxh3_64"

    def _new():
        return xxhash.xxh3_64()
except ImportError:
    import hashlib

    _ALGO = "blake2b"

    def _new():
        return hashlib.blake2b(digest_size=16)

CHUNK = 8 * 1024 * 1024


def algorithm() -> str:
    return _ALGO


def file_digest(path: str | Path, on_chunk=None, should_cancel=None) -> str:
    h = _new()
    with open(path, "rb") as f:
        while True:
            if should_cancel and should_cancel():
                return ""
            buf = f.read(CHUNK)
            if not buf:
                break
            h.update(buf)
            if on_chunk:
                on_chunk(len(buf))
    return h.hexdigest()


def quick_digest(path: str | Path, sample: int = 4 * 1024 * 1024) -> str:
    """Head + tail + size. Catches truncation and gross corruption in
    milliseconds; use file_digest when the answer has to be certain."""
    p = Path(path)
    size = p.stat().st_size
    h = _new()
    h.update(str(size).encode())
    with open(p, "rb") as f:
        h.update(f.read(sample))
        if size > sample * 2:
            f.seek(-sample, 2)
            h.update(f.read(sample))
    return h.hexdigest()
