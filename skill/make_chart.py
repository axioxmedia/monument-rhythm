#!/usr/bin/env python3
"""Generate a Monument Rhythm song pack from an arbitrary audio file."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus", ".webm"}


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]+", "", text, flags=re.UNICODE)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "song"


def decode_mono(path: Path, sr: int = 22050) -> np.ndarray:
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ac",
        "1",
        "-ar",
        str(sr),
        "pipe:1",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace") or "ffmpeg failed to decode audio")
    samples = np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)
    if samples.size == 0:
        raise RuntimeError("decoded audio is empty")
    peak = np.max(np.abs(samples))
    if peak > 0:
        samples = samples / peak
    return samples


def audio_duration(path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def spectral_flux(samples: np.ndarray, sr: int, n_fft: int = 2048, hop: int = 256) -> tuple[np.ndarray, np.ndarray]:
    window = np.hanning(n_fft)
    n_frames = 1 + max(0, (len(samples) - n_fft) // hop)
    prev = np.zeros(n_fft // 2 + 1)
    flux = np.zeros(n_frames)
    times = (np.arange(n_frames) * hop + n_fft / 2) / sr
    for i in range(n_frames):
        start = i * hop
        frame = samples[start : start + n_fft]
        if len(frame) < n_fft:
            frame = np.pad(frame, (0, n_fft - len(frame)))
        mag = np.abs(np.fft.rfft(frame * window))
        diff = mag - prev
        flux[i] = np.sum(diff[diff > 0])
        prev = mag
    if flux.max() > 0:
        flux = flux / flux.max()
    # High-pass the flux so slow loudness ramps do not dominate.
    kernel = np.ones(9) / 9.0
    smooth = np.convolve(flux, kernel, mode="same")
    high = np.clip(flux - 0.55 * smooth, 0, None)
    if high.max() > 0:
        high = high / high.max()
    return times, high


def pick_peaks(times: np.ndarray, env: np.ndarray, min_gap: float, keep_pct: float) -> np.ndarray:
    if env.size == 0:
        return np.array([], dtype=np.float64)
    thresh = float(np.quantile(env, 1.0 - keep_pct))
    thresh = max(thresh, 0.12)
    peaks: list[float] = []
    last_t = -1e9
    i = 1
    n = len(env) - 1
    while i < n:
        if env[i] >= thresh and env[i] >= env[i - 1] and env[i] >= env[i + 1] and (times[i] - last_t) >= min_gap:
            peaks.append(float(times[i]))
            last_t = times[i]
        i += 1
    return np.asarray(peaks, dtype=np.float64)


def estimate_bpm(onsets: np.ndarray) -> float:
    if len(onsets) < 8:
        return 100.0
    iv = np.diff(onsets)
    iv = iv[(iv > 0.18) & (iv < 1.6)]
    if iv.size < 4:
        return 100.0
    # Histogram of implied quarter-note tempos.
    tempos = 60.0 / iv
    # Fold into 70–160.
    folded = []
    for t in tempos:
        while t < 70:
            t *= 2
        while t > 160:
            t /= 2
        folded.append(t)
    hist, edges = np.histogram(folded, bins=36, range=(70, 160))
    idx = int(np.argmax(hist))
    bpm = 0.5 * (edges[idx] + edges[idx + 1])
    return float(round(bpm * 2) / 2)


def quantize(onsets: np.ndarray, bpm: float, strength: float = 0.35) -> np.ndarray:
    if bpm <= 0 or onsets.size == 0:
        return onsets
    step = 60.0 / bpm / 2.0  # eighth notes
    grid = np.round(onsets / step) * step
    return onsets * (1.0 - strength) + grid * strength


def energy_at(samples: np.ndarray, sr: int, t: float, width: float = 0.12) -> float:
    a = max(0, int((t - width) * sr))
    b = min(len(samples), int((t + width) * sr))
    if b <= a:
        return 0.0
    return float(np.sqrt(np.mean(samples[a:b] ** 2)))


def assign_lanes(onsets: np.ndarray, samples: np.ndarray, sr: int, lanes: int, difficulty: str) -> list[dict]:
    notes: list[dict] = []
    if onsets.size == 0:
        return notes
    energies = np.array([energy_at(samples, sr, t) for t in onsets])
    if energies.max() > 0:
        energies = energies / energies.max()
    hand = 0
    last_lane = -1
    motif = [0, 1, 3, 2, 0, 2, 1, 3]
    for i, t in enumerate(onsets):
        strong = energies[i] > 0.62
        lane = motif[i % len(motif)]
        if difficulty == "easy":
            lane = (0 if hand == 0 else lanes - 1) if not strong else (1 if lanes > 2 else 0)
            hand ^= 1
        elif difficulty == "hard":
            if strong and last_lane >= 0:
                lane = (last_lane + (2 if i % 2 == 0 else 1)) % lanes
            else:
                lane = (lane + i // 7) % lanes
        else:
            if i % 5 == 0:
                lane = (last_lane + 2) % lanes if last_lane >= 0 else lane
        if lane == last_lane and difficulty != "easy":
            lane = (lane + 1) % lanes
        last_lane = lane
        notes.append({"t": round(float(t), 4), "lane": int(lane), "type": "tap"})
        # Sparse chords on strong hits.
        chord_ok = difficulty == "hard" or (difficulty == "normal" and i % 11 == 0)
        if chord_ok and strong and i + 1 < len(onsets) and (onsets[i + 1] - t) > 0.18:
            other = (lane + (2 if lanes > 2 else 1)) % lanes
            notes.append({"t": round(float(t), 4), "lane": int(other), "type": "tap"})
    # Promote isolated notes followed by a gap into holds.
    notes.sort(key=lambda n: (n["t"], n["lane"]))
    hold_chance = {"easy": 0.06, "normal": 0.12, "hard": 0.18}[difficulty]
    by_time: dict[float, list[dict]] = {}
    for n in notes:
        by_time.setdefault(n["t"], []).append(n)
    times = sorted(by_time)
    for idx, tt in enumerate(times[:-1]):
        nxt = times[idx + 1]
        gap = nxt - tt
        if gap < 0.42:
            continue
        for n in by_time[tt]:
            if n["type"] != "tap":
                continue
            seed = (n["lane"] * 17 + int(tt * 100)) % 100
            if seed / 100.0 > hold_chance:
                continue
            n["type"] = "hold"
            n["end"] = round(float(min(tt + min(gap * 0.72, 1.8), nxt - 0.08)), 4)
            if n["end"] - n["t"] < 0.18:
                n["type"] = "tap"
                n.pop("end", None)
    notes.sort(key=lambda n: (n["t"], n["lane"]))
    # Dedup exact lane+time collisions.
    cleaned: list[dict] = []
    seen = set()
    for n in notes:
        key = (n["t"], n["lane"])
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(n)
    return cleaned


PRESETS = {
    "easy": {"keep": 0.38, "gap": 0.22},
    "normal": {"keep": 0.58, "gap": 0.14},
    "hard": {"keep": 0.78, "gap": 0.09},
}


def build_chart(audio_path: Path, title: str, artist: str, difficulty: str, lanes: int) -> dict:
    sr = 22050
    samples = decode_mono(audio_path, sr=sr)
    duration = len(samples) / sr
    times, flux = spectral_flux(samples, sr)
    preset = PRESETS[difficulty]
    onsets = pick_peaks(times, flux, min_gap=preset["gap"], keep_pct=preset["keep"])
    # Drop intro silence and trailing fade.
    onsets = onsets[(onsets > 0.35) & (onsets < duration - 0.25)]
    bpm = estimate_bpm(onsets)
    onsets = quantize(onsets, bpm, strength=0.28)
    onsets = np.unique(np.round(onsets, 4))
    notes = assign_lanes(onsets, samples, sr, lanes, difficulty)
    preview = float(onsets[min(8, len(onsets) - 1)]) if len(onsets) else 8.0
    return {
        "version": 1,
        "title": title,
        "artist": artist,
        "audio": audio_path.name,
        "duration": round(duration, 3),
        "bpm": bpm,
        "offset": 0.0,
        "lanes": lanes,
        "difficulty": difficulty,
        "preview": round(preview, 3),
        "notes": notes,
    }


def write_pack(audio_path: Path, out_root: Path, chart: dict) -> Path:
    slug = slugify(chart["title"])
    dest = out_root / slug
    dest.mkdir(parents=True, exist_ok=True)
    target_audio = dest / audio_path.name
    if audio_path.resolve() != target_audio.resolve():
        shutil.copy2(audio_path, target_audio)
    chart["audio"] = target_audio.name
    (dest / "chart.json").write_text(json.dumps(chart, ensure_ascii=False, indent=2), encoding="utf-8")
    return dest


def main() -> int:
    p = argparse.ArgumentParser(description="Build a Monument Rhythm song pack from audio.")
    p.add_argument("audio", type=Path, help="Source audio file")
    p.add_argument("--out", type=Path, required=True, help="Library root (songs/)")
    p.add_argument("--title", default="")
    p.add_argument("--artist", default="Unknown")
    p.add_argument("--difficulty", choices=("easy", "normal", "hard"), default="normal")
    p.add_argument("--lanes", type=int, default=4)
    args = p.parse_args()
    if not args.audio.is_file():
        print(f"missing audio: {args.audio}", file=sys.stderr)
        return 2
    title = args.title.strip() or args.audio.stem
    chart = build_chart(args.audio, title, args.artist, args.difficulty, args.lanes)
    dest = write_pack(args.audio, args.out, chart)
    print(json.dumps({"pack": str(dest), "notes": len(chart["notes"]), "bpm": chart["bpm"], "duration": chart["duration"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
