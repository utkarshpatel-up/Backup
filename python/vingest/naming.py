"""Filename / folder-name construction and parsing.

House convention (from the reference tree):

    3017 Dt-16 Aug 2026/
      Adalaj Soneri ... General Satsang E. Dt-16-Aug-26 Dur-54m1s/
        <master original name> Dt-16-Aug-26 Dur-54m1s.mov
        Clips for Insert/
          Cam-01/  Cam-02/  Cam-03/
            C0031 Dt-16-Aug-26 Dur-2m14s.mov
"""

from __future__ import annotations

import datetime as _dt
import re
import unicodedata

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# " Dt-16-Aug-26" / "Dt-16-Aug-2026"
DATE_TOKEN_RE = re.compile(r"\s*\bDt-(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\b")
# " Dur-54m1s" / "Dur-1h2m3s" / "Dur-48s"
DUR_TOKEN_RE = re.compile(r"\s*\bDur-(?:\d+h)?(?:\d+m)?\d+s\b", re.IGNORECASE)

# Characters no filesystem we target will accept.
ILLEGAL_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
# Windows refuses these names regardless of extension.
RESERVED = {"CON", "PRN", "AUX", "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10))}

CAM_FOLDER_RE = re.compile(r"^Cam-(\d{2,})$")
CLIPS_DIRNAME = "Clips for Insert"


def fmt_duration(seconds: float | None) -> str:
    """54.9s -> '54s'; 3241.4 -> '54m1s'; 7384 -> '2h3m4s'.

    Seconds are truncated, not rounded: a 54m1.9s file reads 54m1s, which is
    what the reference folder name shows for a 3241.9s master.
    """
    if seconds is None:
        return ""
    total = int(seconds)
    if total < 0:
        total = 0
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    out = ""
    if h:
        out += f"{h}h"
    if h or m:
        out += f"{m}m"
    return out + f"{s}s"


def parse_duration(text: str) -> int | None:
    """Inverse of fmt_duration, for reading a Dur- token back off a name."""
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(\d+)s", text.strip(), re.IGNORECASE)
    if not m:
        return None
    h, mi, s = (int(g or 0) for g in m.groups())
    return h * 3600 + mi * 60 + s


def fmt_date(when: _dt.datetime | _dt.date, four_digit_year: bool = False) -> str:
    """-> '16-Aug-26' (folder/file token body)."""
    year = when.year if four_digit_year else when.year % 100
    width = 4 if four_digit_year else 2
    return f"{when.day:02d}-{MONTHS[when.month - 1]}-{year:0{width}d}"


def fmt_job_date(when: _dt.datetime | _dt.date) -> str:
    """-> '16 Aug 2026', the spaced form used on the job (parent) folder."""
    return f"{when.day:02d} {MONTHS[when.month - 1]} {when.year}"


def parse_date_token(name: str) -> _dt.date | None:
    m = DATE_TOKEN_RE.search(name)
    if not m:
        return None
    day, mon, year = m.group(1), m.group(2).title(), int(m.group(3))
    if mon not in MONTHS:
        return None
    if year < 100:
        year += 2000
    try:
        return _dt.date(year, MONTHS.index(mon) + 1, int(day))
    except ValueError:
        return None


def strip_tokens(name: str) -> str:
    """Remove any existing Dt-/Dur- tokens so renames stay idempotent."""
    name = DUR_TOKEN_RE.sub("", name)
    name = DATE_TOKEN_RE.sub("", name)
    # Trailing periods are meaningful here ("... General Satsang E."), so only
    # whitespace and stray hyphens left behind by token removal are trimmed.
    return re.sub(r"\s{2,}", " ", name).strip().strip("-").strip()


def sanitize(name: str, replacement: str = "-") -> str:
    """Make `name` safe on both macOS and Windows, without gutting it."""
    name = unicodedata.normalize("NFC", name)
    name = ILLEGAL_RE.sub(replacement, name)
    name = re.sub(r"\s{2,}", " ", name).strip()
    # Windows silently drops trailing dots and spaces; do it ourselves so the
    # name we record is the name that lands on disk.
    name = name.rstrip(" .")
    stem = name.split(".")[0].upper()
    if stem in RESERVED:
        name = "_" + name
    return name or "untitled"


def build_name(base: str, when=None, seconds: float | None = None,
               ext: str = "", four_digit_year: bool = False) -> str:
    """'C0031' + 16 Aug 26 + 134s -> 'C0031 Dt-16-Aug-26 Dur-2m14s.mov'.

    Any Dt-/Dur- tokens already on `base` are replaced, so re-running the
    ingest over an already-named file is a no-op rather than a pile-up.
    """
    out = strip_tokens(base)
    if when is not None:
        out += f" Dt-{fmt_date(when, four_digit_year)}"
    if seconds is not None:
        out += f" Dur-{fmt_duration(seconds)}"
    if ext and not ext.startswith("."):
        ext = "." + ext
    return sanitize(out) + ext.lower()


def build_session_folder(title: str, when=None, seconds: float | None = None) -> str:
    return build_name(title, when, seconds, ext="")


def build_job_folder(job_number: str, when) -> str:
    """'3017' + 16 Aug 2026 -> '3017 Dt-16 Aug 2026'."""
    job = sanitize(str(job_number).strip())
    return f"{job} Dt-{fmt_job_date(when)}" if job else f"Dt-{fmt_job_date(when)}"


def cam_folder(index: int) -> str:
    return f"Cam-{int(index):02d}"


def dedupe(name: str, taken: set[str]) -> str:
    """Append ' (2)', ' (3)'... before the extension until `name` is free.

    Comparison is case-insensitive because the SSDs may be exFAT.
    """
    lowered = {t.lower() for t in taken}
    if name.lower() not in lowered:
        return name
    if "." in name[1:]:
        stem, _, ext = name.rpartition(".")
        ext = "." + ext
    else:
        stem, ext = name, ""
    n = 2
    while f"{stem} ({n}){ext}".lower() in lowered:
        n += 1
    return f"{stem} ({n}){ext}"
