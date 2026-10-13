"""ffmpeg / ffprobe helpers. Every command is an argument list; nothing goes through a shell."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable

CancelCheck = Callable[[], None]


class MediaError(RuntimeError):
    pass


def run(args: list[str], *, check_cancel: CancelCheck | None = None, timeout: float | None = None) -> str:
    """Run ffmpeg with the given arguments; returns stderr (ffmpeg writes analysis output there)."""
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y", *args]
    proc = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines: list[str] = []
    assert proc.stderr is not None
    for line in proc.stderr:
        lines.append(line)
        if len(lines) > 4000:
            del lines[:2000]
        if check_cancel:
            try:
                check_cancel()
            except BaseException:
                proc.kill()
                raise
    proc.wait(timeout=timeout)
    stderr = "".join(lines)
    if proc.returncode != 0:
        raise MediaError(f"ffmpeg failed ({proc.returncode}): {stderr[-1500:]}")
    return stderr


def probe(path: Path) -> dict[str, Any]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if out.returncode != 0:
        raise MediaError(f"ffprobe failed for {path.name}: {out.stderr[-500:]}")
    return json.loads(out.stdout)


def duration(path: Path) -> float:
    info = probe(path)
    d = info.get("format", {}).get("duration")
    if d is None:
        for s in info.get("streams", []):
            if s.get("duration"):
                d = s["duration"]
                break
    if d is None:
        raise MediaError(f"No duration for {path.name}")
    return float(d)


_LOUDNORM_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def measure_loudness(path: Path, target_i: float = -16.0, target_tp: float = -1.5, target_lra: float = 11.0) -> dict[str, float]:
    """First loudnorm pass: integrated loudness, true peak, LRA, threshold, offset."""
    stderr = run(
        [
            "-i", str(path),
            "-af", f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=json",
            "-f", "null", "-",
        ]
    )
    match = _LOUDNORM_JSON.findall(stderr)
    if not match:
        raise MediaError("loudnorm produced no measurement")
    data = json.loads(match[-1])
    return {k: float(v) for k, v in data.items() if k != "normalization_type" and _is_number(v)}


def _is_number(v: Any) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def loudnorm_filter(measured: dict[str, float], target_i: float, target_tp: float, target_lra: float = 11.0) -> str:
    """Second-pass loudnorm filter string using first-pass measurements (linear mode)."""
    if measured.get("input_i", -70.0) <= -70.0:
        return "anull"  # silence: nothing to normalise
    return (
        f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured.get('target_offset', 0.0)}:linear=true:print_format=json"
    )


def peak_db(path: Path) -> float:
    stderr = run(["-i", str(path), "-af", "volumedetect", "-f", "null", "-"])
    match = re.search(r"max_volume:\s*(-?[\d.]+|-inf) dB", stderr)
    if not match or match.group(1) == "-inf":
        return -120.0
    return float(match.group(1))


def normalize_clip(src: Path, dest: Path, *, target_lufs: float = -23.0, short_peak_db: float = -9.0,
                   short_threshold_sec: float = 3.0, max_duration: float | None = None, sample_rate: int = 48000) -> dict[str, float]:
    """Normalise one SFX clip. Long clips: two-pass loudnorm. Short clips: peak gain (LUFS is unreliable)."""
    trimmed = ["-t", f"{max_duration:.3f}"] if max_duration else []
    length = duration(src)
    if max_duration:
        length = min(length, max_duration)
    if length >= short_threshold_sec:
        measured = measure_loudness(src, target_lufs, -2.0)
        flt = loudnorm_filter(measured, target_lufs, -2.0)
        method = "loudnorm"
    else:
        peak = peak_db(src)
        gain = 0.0 if peak <= -119 else short_peak_db - peak
        flt = f"volume={gain:.2f}dB"
        measured = {"input_peak_db": peak, "gain_db": gain}
        method = "peak"
    run(["-i", str(src), *trimmed, "-af", f"{flt},aresample={sample_rate}", "-ac", "2", "-c:a", "flac", str(dest)])
    return {"method_loudnorm": 1.0 if method == "loudnorm" else 0.0, "duration_sec": length, **measured}


def silence(dest: Path, seconds: float, sample_rate: int = 48000, channels: int = 2) -> None:
    layout = "stereo" if channels == 2 else "mono"
    run(["-f", "lavfi", "-i", f"anullsrc=r={sample_rate}:cl={layout}", "-t", f"{seconds:.3f}", "-c:a", "flac", str(dest)])


def image_size(path: Path) -> tuple[int, int]:
    info = probe(path)
    for s in info.get("streams", []):
        if s.get("width"):
            return int(s["width"]), int(s["height"])
    raise MediaError(f"Not an image: {path.name}")


def write_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return path
