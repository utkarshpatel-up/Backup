"""Read clip durations straight from container headers — no ffprobe, no deps.

Ported from the operator's vidcount tool so the app reports the same numbers
that tool does. Pure standard library, so it works in the frozen build without
ffmpeg installed. Anything it cannot parse returns ``None`` (counted as an
"unknown duration"), rather than raising.

Supported: MP4/MOV/M4V/M4A, MKV/WebM, AVI, WMV/ASF/WMA, FLV, WAV, FLAC,
OGG/OPUS, MP3, and MPEG-TS (MTS/M2TS/TS).
"""

from __future__ import annotations

import os
import struct
from pathlib import Path
from typing import Optional

_MP4_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"udta", b"moof"}


def _mp4(path: Path) -> Optional[float]:
    """mvhd atom timescale/duration (MP4/MOV/M4V/M4A)."""
    try:
        fsize = os.path.getsize(path)
        with open(path, "rb") as f:
            def read_boxes(limit):
                while f.tell() < limit - 8:
                    pos = f.tell()
                    size = int.from_bytes(f.read(4), "big")
                    name = f.read(4)
                    if size == 1:
                        size = int.from_bytes(f.read(8), "big")
                    elif size == 0:
                        size = limit - pos
                    if size < 8 or pos + size > limit + 8:
                        break
                    if name == b"mvhd":
                        ver = int.from_bytes(f.read(1), "big"); f.read(3)
                        if ver == 1:
                            f.read(16); scale = int.from_bytes(f.read(4), "big")
                            dur = int.from_bytes(f.read(8), "big")
                        else:
                            f.read(8); scale = int.from_bytes(f.read(4), "big")
                            dur = int.from_bytes(f.read(4), "big")
                        return dur / scale if scale else None
                    elif name in _MP4_CONTAINERS:
                        r = read_boxes(pos + size)
                        if r is not None:
                            return r
                    f.seek(pos + size)
                return None
            return read_boxes(fsize)
    except Exception:
        return None


def _mkv(path: Path) -> Optional[float]:
    """EBML TimecodeScale + Duration (MKV/WebM)."""
    def read_vint(data, pos):
        if pos >= len(data):
            return 0, pos
        b = data[pos]; w = 1; mask = 0x80
        while not (b & mask):
            w += 1; mask >>= 1
        if pos + w > len(data):
            return 0, pos + w
        val = b & (mask - 1)
        for k in range(1, w):
            val = (val << 8) | data[pos + k]
        return val, pos + w
    try:
        with open(path, "rb") as f:
            data = f.read(min(2 * 1024 * 1024, os.path.getsize(path)))
        pos = 0; ts = 1_000_000; dur = None
        while pos < len(data) - 4:
            b = data[pos]
            if b == 0:
                pos += 1; continue
            iw = 1; mask = 0x80
            while not (b & mask) and iw <= 4:
                iw += 1; mask >>= 1
            if pos + iw > len(data):
                break
            eid = int.from_bytes(data[pos:pos + iw], "big"); pos += iw
            sz, pos = read_vint(data, pos)
            if sz == 0 or pos + sz > len(data):
                if eid in (0x18538067, 0x1549A966):
                    continue
                pos += 1; continue
            content = data[pos:pos + sz]; pos += sz
            if eid == 0x2AD7B1 and sz <= 8:
                ts = int.from_bytes(content, "big")
            elif eid == 0x4489:
                dur = struct.unpack(">f", content)[0] if sz == 4 else struct.unpack(">d", content)[0]
            if dur is not None and ts:
                return dur * ts / 1e9
        return None
    except Exception:
        return None


def _avi(path: Path) -> Optional[float]:
    """RIFF avih chunk: TotalFrames x MicroSecPerFrame."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF":
                return None
            f.read(4)
            if f.read(4) != b"AVI ":
                return None
            for _ in range(200):
                cid = f.read(4)
                if len(cid) < 4:
                    break
                csz = struct.unpack("<I", f.read(4))[0]
                if cid == b"avih":
                    mpf = struct.unpack("<I", f.read(4))[0]; f.read(12)
                    tf = struct.unpack("<I", f.read(4))[0]
                    return tf * mpf / 1e6 if mpf and tf else None
                elif cid in (b"LIST", b"hdrl"):
                    f.read(4)
                else:
                    f.seek(csz + (csz % 2), 1)
        return None
    except Exception:
        return None


def _wmv(path: Path) -> Optional[float]:
    """ASF header File Properties play duration (WMV/ASF/WMA)."""
    H = b"\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C"
    F = b"\xA1\xDC\xAB\x8C\x47\xA9\xCF\x11\x8E\xE4\x00\xC0\x0C\x20\x53\x65"
    try:
        with open(path, "rb") as f:
            if f.read(16) != H:
                return None
            f.read(8); n = struct.unpack("<I", f.read(4))[0]; f.read(2)
            for _ in range(n):
                g = f.read(16)
                if len(g) < 16:
                    break
                sz = struct.unpack("<Q", f.read(8))[0]
                if g == F:
                    f.read(32); pd = struct.unpack("<Q", f.read(8))[0]
                    f.read(8); pr = struct.unpack("<Q", f.read(8))[0]
                    return max(pd / 1e7 - pr / 1e3, 0.0)
                f.seek(sz - 24, 1)
        return None
    except Exception:
        return None


def _flv(path: Path) -> Optional[float]:
    try:
        with open(path, "rb") as f:
            if f.read(3) != b"FLV":
                return None
            f.read(2); off = struct.unpack(">I", f.read(4))[0]
            f.seek(off); f.read(4)
            for _ in range(5):
                tt = f.read(1)
                if not tt:
                    break
                ds = int.from_bytes(f.read(3), "big"); f.read(4)
                body = f.read(ds)
                if tt == b"\x12":
                    idx = body.find(b"duration")
                    if idx != -1:
                        for k in range(idx, min(idx + 30, len(body) - 9)):
                            if body[k] == 0x00:
                                val = struct.unpack(">d", body[k + 1:k + 9])[0]
                                if 0 < val < 1e7:
                                    return val
                f.read(4)
        return None
    except Exception:
        return None


def _wav(path: Path) -> Optional[float]:
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF":
                return None
            f.read(4)
            if f.read(4) != b"WAVE":
                return None
            sr = ch = bits = None
            for _ in range(50):
                cid = f.read(4)
                if len(cid) < 4:
                    break
                csz = struct.unpack("<I", f.read(4))[0]
                if cid == b"fmt ":
                    f.read(2)
                    ch = struct.unpack("<H", f.read(2))[0]
                    sr = struct.unpack("<I", f.read(4))[0]
                    f.read(6)
                    bits = struct.unpack("<H", f.read(2))[0]
                    f.seek(max(0, csz - 16), 1)
                elif cid == b"data":
                    if sr and bits and ch:
                        return csz // (ch * max(bits // 8, 1)) / sr
                    break
                else:
                    f.seek(csz + (csz % 2), 1)
        return None
    except Exception:
        return None


def _flac(path: Path) -> Optional[float]:
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"fLaC":
                return None
            while True:
                hdr = f.read(4)
                if len(hdr) < 4:
                    break
                last = (hdr[0] & 0x80) != 0
                bsz = int.from_bytes(hdr[1:4], "big")
                if (hdr[0] & 0x7F) == 0:
                    d = f.read(bsz)
                    sr = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4)
                    total = ((d[13] & 0x0F) << 32) | (d[14] << 24) | (d[15] << 16) | (d[16] << 8) | d[17]
                    return total / sr if sr else None
                f.seek(bsz, 1)
                if last:
                    break
        return None
    except Exception:
        return None


def _ogg(path: Path) -> Optional[float]:
    try:
        fsize = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(min(8192, fsize))
            if head[:4] != b"OggS":
                return None
            idx = head.find(b"\x01vorbis")
            if idx == -1:
                return None
            sr = struct.unpack("<I", head[idx + 12:idx + 16])[0]
            if not sr:
                return None
            f.seek(max(0, fsize - 65536))
            tail = f.read(); last_g = -1; pos = 0
            while True:
                i = tail.find(b"OggS", pos)
                if i == -1 or i + 14 > len(tail):
                    break
                g = struct.unpack("<q", tail[i + 6:i + 14])[0]
                if g > 0:
                    last_g = g
                pos = i + 1
            return last_g / sr if last_g > 0 else None
    except Exception:
        return None


def _mp3(path: Path) -> Optional[float]:
    BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    SRATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    try:
        fsize = os.path.getsize(path)
        with open(path, "rb") as f:
            data = f.read(min(16384, fsize))
        off = 0
        if data[:3] == b"ID3":
            off = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
            off += 10
        for i in range(off, min(off + 4096, len(data) - 4)):
            if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0:
                b1, b2 = data[i + 1], data[i + 2]
                ver, layer = (b1 >> 3) & 3, (b1 >> 1) & 3
                br_i, sr_i = (b2 >> 4) & 0xF, (b2 >> 2) & 3
                if layer != 1 or ver not in SRATES or sr_i > 2:
                    continue
                sr = SRATES[ver][sr_i]; br = BITRATES[br_i] if br_i < 16 else 0
                if br == 0:
                    continue
                xo = i + 36
                if xo + 8 <= len(data) and data[xo:xo + 4] in (b"Xing", b"Info"):
                    flags = struct.unpack(">I", data[xo + 4:xo + 8])[0]
                    if flags & 0x1:
                        frames = struct.unpack(">I", data[xo + 8:xo + 12])[0]
                        return frames * (1152 if ver == 3 else 576) / sr
                return (fsize - off) * 8 / (br * 1000)
        return None
    except Exception:
        return None


def _mts(path: Path) -> Optional[float]:
    """MPEG-TS / AVCHD duration from first/last PCR (27 MHz clock)."""
    def scan(data, pkt_size, pkt_offset, last):
        SYNC = 0x47
        found = None; i = 0
        while i + pkt_size <= len(data):
            if data[i + pkt_offset] != SYNC:
                i += 1; continue
            pkt = data[i + pkt_offset: i + pkt_offset + 188]
            if len(pkt) < 6:
                i += pkt_size; continue
            af_ctrl = (pkt[3] >> 4) & 0x3
            if af_ctrl in (2, 3) and pkt[4] >= 7 and pkt[5] & 0x10 and len(pkt) >= 12:
                b = pkt[6:12]
                base = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
                ext = ((b[4] & 1) << 8) | b[5]
                pcr = base * 300 + ext
                if not last:
                    return pcr
                found = pcr
            i += pkt_size
        return found
    try:
        fsize = os.path.getsize(path)
        chunk = 512 * 1024
        for pkt_size, pkt_offset in ((188, 0), (192, 4)):
            with open(path, "rb") as f:
                head = f.read(min(chunk, fsize))
            first = scan(head, pkt_size, pkt_offset, last=False)
            if first is None:
                continue
            with open(path, "rb") as f:
                f.seek(max(0, fsize - chunk)); tail = f.read()
            last = scan(tail, pkt_size, pkt_offset, last=True)
            if last is None:
                continue
            if last < first:
                last += (2 ** 33) * 300
            dur = (last - first) / 27_000_000
            if dur > 0:
                return dur
        return None
    except Exception:
        return None


def get_duration(path) -> Optional[float]:
    """Seconds for a media file, or None if the header can't be read."""
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in ("mp4", "mov", "m4v", "m4a"):
        return _mp4(Path(path))
    if ext in ("mkv", "webm"):
        return _mkv(Path(path))
    if ext == "avi":
        return _avi(Path(path))
    if ext in ("wmv", "asf", "wma"):
        return _wmv(Path(path))
    if ext == "flv":
        return _flv(Path(path))
    if ext == "wav":
        return _wav(Path(path))
    if ext == "flac":
        return _flac(Path(path))
    if ext in ("ogg", "opus"):
        return _ogg(Path(path))
    if ext == "mp3":
        return _mp3(Path(path))
    if ext in ("mts", "m2ts", "ts"):
        return _mts(Path(path))
    return None


def fmt_human(sec: Optional[float]) -> str:
    """'1h 2m 3s' / '2m 3s' / '3s' (matches the vidcount output)."""
    if sec is None or sec < 0:
        return ""
    s = int(sec); h, s = divmod(s, 3600); m, s = divmod(s, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def fmt_hms(sec: Optional[float]) -> str:
    """'HH:MM:SS'."""
    if sec is None or sec < 0:
        return ""
    s = int(sec); h, s = divmod(s, 3600); m, s = divmod(s, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def format_duration(sec: Optional[float], style: str = "human") -> str:
    """Render seconds in the style the target field expects."""
    if sec is None:
        return ""
    if style == "seconds":
        return str(int(round(sec)))
    if style == "hms":
        return fmt_hms(sec)
    return fmt_human(sec)
