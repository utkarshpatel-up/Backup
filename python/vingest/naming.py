"""Folder-name construction and parsing.

House convention (from the reference tree):

    3017 Dt-16 Aug 2026/
      Adalaj Soneri ... General Satsang E. Dt-16-Aug-26 Dur-54m1s/
        <master file, name untouched>
        Clips for Insert/
          Cam-01/  Cam-02/  Cam-03/
            <clips, names untouched>

Media files are NEVER renamed — they arrive already named correctly. The only
name this module generates is the session folder's, and the only part of that
which is derived from the media is the `Dur-` token.
"""

from __future__ import annotations

import datetime as _dt
import re
import unicodedata

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# " Dt-16-Aug-26" / "Dt-16-Aug-2026"
DATE_TOKEN_RE = re.compile(r"\s*\bDt-(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\b")
# " Dur-54m1s" / "Dur-1h2m3s" / "Dur-48s" / "Dur-1h0m" / "Dur-1h"
# Every component is optional, but at least one must be present — hence the
# lookahead for a digit. Requiring a trailing seconds component (as this once
# did) leaves an existing "Dur-1h0m" unrecognised, and appends a second token
# beside it instead of replacing it.
DUR_TOKEN_RE = re.compile(
    r"\s*\bDur-(?=\d)(?:\d+h)?(?:\d+m)?(?:\d+s)?\b", re.IGNORECASE)

# Characters no filesystem we target will accept.
ILLEGAL_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
# Windows refuses these names regardless of extension.
RESERVED = {"CON", "PRN", "AUX", "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10))}

CAM_FOLDER_RE = re.compile(r"^Cam-(\d{2,})$")
CLIPS_DIRNAME = "Clips for Insert"


def fmt_duration(seconds: float | None, precision: str = "s") -> str:
    """54.9s -> '54s'; 3241.4 -> '54m1s'; 7384 -> '2h3m4s'.

    Seconds are truncated, not rounded: a 54m1.9s file reads 54m1s, which is
    what the reference folder name shows for a 3241.9s master.

    `precision` is the smallest unit to write — 's' for the full h/m/s form,
    'm' to stop at minutes ('1h0m'), 'h' to stop at hours. Existing folder names
    are written in more than one of these shapes, so the shape is carried over
    from whatever the folder already uses rather than imposed.
    """
    if seconds is None:
        return ""
    total = max(int(seconds), 0)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)

    if precision == "h":
        return f"{h}h"
    if precision == "m":
        return (f"{h}h" if h else "") + f"{m}m"
    return (f"{h}h" if h else "") + (f"{m}m" if h or m else "") + f"{s}s"


def token_precision(body: str) -> str:
    """The smallest unit a written token uses: '1h0m' -> 'm', '54m1s' -> 's'."""
    body = body.strip().lower()
    for unit in ("s", "m", "h"):
        if body.endswith(unit):
            return unit
    return "s"


def complete_with_dur(name: str, seconds: float | None) -> str:
    """Put the right `Dur-` token on `name`, in the shape the name already uses.

    Replaces an existing token rather than appending beside it, so this is safe
    to run over a folder that has already been through the app.
    """
    token = DUR_TOKEN_RE.search(name)
    precision = token_precision(token.group(0).strip()[4:]) if token else "s"
    base = re.sub(r"\s{2,}", " ", DUR_TOKEN_RE.sub("", name)).strip()
    if seconds is None:
        return sanitize(base)
    return sanitize(f"{base} Dur-{fmt_duration(seconds, precision)}")


def parse_duration(text: str) -> int | None:
    """Inverse of fmt_duration, for reading a Dur- token back off a name.

    Accepts any combination of the three components, so hand-written tokens like
    "1h0m" or "1h" read back as well as the "54m1s" the app generates.
    """
    text = text.strip()
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", text, re.IGNORECASE)
    if not m or not any(m.groups()):
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


def build_session_folder(title: str, when=None, seconds: float | None = None,
                        add_date: bool = True) -> str:
    """Complete the session folder name; only `Dur-` is derived from the media.

    The title is taken as given — whatever the operator typed, or whatever the
    imported zip already called it — and is not otherwise reformatted. A `Dur-`
    token already on the name is replaced rather than appended to, so running
    the ingest twice cannot produce "... Dur-54m1s Dur-54m1s".

    A `Dt-` token is added only when `add_date` is on AND the name does not
    already carry one; a date the operator typed themselves always wins.
    """
    token = DUR_TOKEN_RE.search(title)
    precision = token_precision(token.group(0).strip()[4:]) if token else "s"
    base = DUR_TOKEN_RE.sub("", title)
    base = re.sub(r"\s{2,}", " ", base).strip()
    if add_date and when is not None and not DATE_TOKEN_RE.search(base):
        base += f" Dt-{fmt_date(when)}"
    if seconds is not None:
        base += f" Dur-{fmt_duration(seconds, precision)}"
    return sanitize(base)


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
