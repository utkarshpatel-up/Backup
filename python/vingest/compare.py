"""Comparing two (or three) copies of the same session.

Fast pass: folder tree, file count, duration, size.
Deep pass: content digest per file, on demand.

Sizes legitimately differ between the ProRes and H.265 copies of the same
shoot, so a size difference is only ever an error when both sides are the same
codec family. Between families it is reported as information.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import naming
from .hashing import algorithm, file_digest, quick_digest
from .probe import is_junk, is_video, probe
from .report import MANIFEST_DIR


def _rel_key(root: Path, path: Path, taken: set[str] | None = None) -> str:
    """Relative path used to line the same shot up across drives.

    The extension is left out of the key: the ProRes and H.265 recordings of one
    shot are often written as .mov and .mp4, and dropping the suffix is what
    lets them pair instead of both reporting as missing. Any Dur-/Dt- tokens are
    stripped too, so folders organised by an older version still line up.

    If two files in one folder would collapse to the same key (an "a.mov" beside
    an "a.mp4"), the extension is put back for the second one so neither is lost.
    """
    rel = path.relative_to(root)
    parts = list(rel.parts[:-1]) + [naming.strip_tokens(rel.stem)]
    key = "/".join(p.lower() for p in parts)
    if taken is not None and key in taken:
        key = f"{key}{rel.suffix.lower()}"
    return key


def snapshot(root: str | Path, with_duration: bool = True,
             progress=None, should_cancel=None) -> dict:
    """Index one session folder (or card) for comparison."""
    root = Path(root)
    if not root.exists():
        return {"root": str(root), "error": "Path does not exist", "files": {}}

    files: dict[str, dict] = {}
    dirs: list[str] = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        d = Path(dirpath)
        # Manifests are per-run bookkeeping, not footage: they carry different
        # timestamps on each drive and would report as mismatches forever.
        dirnames[:] = sorted(x for x in dirnames
                             if not is_junk(d / x) and x != MANIFEST_DIR)
        if d != root:
            dirs.append("/".join(p.lower() for p in d.relative_to(root).parts))
        for fn in sorted(filenames):
            p = d / fn
            if is_junk(p):
                continue
            if should_cancel and should_cancel():
                return {"root": str(root), "cancelled": True, "files": files}
            try:
                st = p.stat()
            except OSError:
                continue
            entry = {
                "name": fn,
                "rel": "/".join(p.relative_to(root).parts),
                "ext": p.suffix.lower(),
                "size": st.st_size,
                "mtime": st.st_mtime,
                "duration": None,
                "codec": None,
                "declared_duration": None,
            }
            token = naming.DUR_TOKEN_RE.search(p.stem)
            if token:
                entry["declared_duration"] = naming.parse_duration(
                    token.group(0).strip()[4:])
            if with_duration and is_video(p):
                info = probe(p)
                entry["duration"] = info.duration
                entry["codec"] = info.family
            files[_rel_key(root, p, set(files))] = entry
            total += st.st_size
            if progress and len(files) % 10 == 0:
                progress({"stage": "index", "root": str(root), "count": len(files)})

    return {
        "root": str(root),
        "name": root.name,
        "dirs": sorted(dirs),
        "files": files,
        "file_count": len(files),
        "total_bytes": total,
    }


def compare(snapshots: list[dict], duration_tol: float = 1.0,
            size_tol_pct: float = 0.0) -> dict:
    """Compare two or more snapshots against the first one (the reference)."""
    if len(snapshots) < 2:
        return {"error": "Need at least two sources to compare", "pairs": [], "ok": False}

    invalid = [{"root": snap.get("root"), "error": snap.get("error")}
               for snap in snapshots if snap.get("error")]
    if invalid:
        detail = "; ".join(f"{item['root']}: {item['error']}" for item in invalid)
        return {"error": f"One or more folders cannot be read: {detail}",
                "snapshot_errors": invalid, "pairs": [], "ok": False}

    ref = snapshots[0]
    ref_files = ref.get("files", {})
    results = []
    all_keys = set(ref_files)
    for s in snapshots[1:]:
        all_keys |= set(s.get("files", {}))

    for other in snapshots[1:]:
        o_files = other.get("files", {})
        missing, extra, mismatched, matched = [], [], [], 0

        for key in sorted(all_keys):
            a, b = ref_files.get(key), o_files.get(key)
            if a and not b:
                missing.append(a)
                continue
            if b and not a:
                extra.append(b)
                continue
            if not a or not b:
                continue

            issues = []
            same_family = a.get("codec") and a["codec"] == b.get("codec")

            if a["duration"] is not None and b["duration"] is not None:
                delta = abs(a["duration"] - b["duration"])
                if delta > duration_tol:
                    issues.append({
                        "field": "duration", "severity": "error",
                        "a": round(a["duration"], 2), "b": round(b["duration"], 2),
                        "detail": f"differs by {delta:.2f}s",
                    })

            for side in (a, b):
                if side["declared_duration"] is not None and side["duration"] is not None \
                        and abs(side["declared_duration"] - side["duration"]) > 1.0:
                    issues.append({
                        "field": "name_vs_actual", "severity": "error",
                        "a": side["declared_duration"], "b": round(side["duration"], 2),
                        "detail": f"{side['name']}: Dur- token disagrees with the file",
                    })

            if a.get("ext") != b.get("ext"):
                issues.append({
                    "field": "extension", "severity": "info",
                    "a": a.get("ext"), "b": b.get("ext"),
                    "detail": f"different container: {a.get('ext')} vs {b.get('ext')}",
                })

            if a["size"] != b["size"]:
                pct = abs(a["size"] - b["size"]) / max(a["size"], 1) * 100
                if same_family and pct > size_tol_pct:
                    issues.append({
                        "field": "size", "severity": "error",
                        "a": a["size"], "b": b["size"],
                        "detail": f"same codec ({a['codec']}) but sizes differ by {pct:.1f}%",
                    })
                else:
                    issues.append({
                        "field": "size", "severity": "info",
                        "a": a["size"], "b": b["size"],
                        "detail": f"expected: {a.get('codec')} vs {b.get('codec')}",
                    })

            if any(i["severity"] == "error" for i in issues):
                mismatched.append({"key": key, "a": a, "b": b, "issues": issues})
            else:
                matched += 1
                if issues:
                    mismatched.append({"key": key, "a": a, "b": b,
                                       "issues": issues, "info_only": True})

        errors = [m for m in mismatched if not m.get("info_only")]
        tree_equal = ref.get("dirs") == other.get("dirs")
        results.append({
            "reference": ref.get("root"),
            "other": other.get("root"),
            "matched": matched,
            "missing_from_other": missing,
            "extra_in_other": extra,
            "mismatched": mismatched,
            "ok": not missing and not extra and not errors and tree_equal,
            "tree_equal": tree_equal,
        })

    return {
        "reference": ref.get("root"),
        "pairs": results,
        "ok": all(r["ok"] for r in results),
    }


def deep_verify(pairs: list[tuple[str, str]], quick: bool = False,
                progress=None, should_cancel=None) -> dict:
    """Digest both sides of each (a, b) pair and report any that differ.

    Only meaningful between copies of the SAME codec family — a ProRes file and
    its H.265 twin are different footage encodings and will never match.
    """
    out = []
    total = len(pairs)
    for n, (a, b) in enumerate(pairs, 1):
        if should_cancel and should_cancel():
            return {"cancelled": True, "results": out, "algorithm": algorithm()}
        if progress:
            progress({"stage": "verify", "done": n, "total": total,
                      "name": Path(a).name})
        try:
            fn = quick_digest if quick else file_digest
            ha, hb = fn(a), fn(b)
            out.append({"a": a, "b": b, "hash_a": ha, "hash_b": hb,
                        "match": ha == hb})
        except OSError as e:
            out.append({"a": a, "b": b, "match": False, "error": str(e)})
    return {
        "algorithm": ("quick " if quick else "") + algorithm(),
        "results": out,
        "checked": len(out),
        "mismatched": [r for r in out if not r["match"]],
        "ok": all(r["match"] for r in out),
    }


def pair_for_verify(snap_a: dict, snap_b: dict) -> list[tuple[str, str]]:
    """Same-key files present on both sides, as absolute path pairs."""
    a_root, b_root = Path(snap_a["root"]), Path(snap_b["root"])
    pairs = []
    for key, a in snap_a.get("files", {}).items():
        b = snap_b.get("files", {}).get(key)
        if b:
            pairs.append((str(a_root / a["rel"]), str(b_root / b["rel"])))
    return pairs
