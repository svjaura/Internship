#!/usr/bin/env python3
"""Local meeting transcription with faster-whisper. Audio never leaves the Mac.

  python3 -m pip install faster-whisper          # once
  python3 scripts/transcribe.py meetings/2026-11-03-oak-street-roofing/recording.m4a [--model small.en]

Writes transcript.txt (with [mm:ss] stamps) and transcript.srt next to the recording.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def stamp(seconds: float, srt: bool = False) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if srt:
        return f"{h:02}:{m:02}:{s:02},{int((seconds % 1) * 1000):03}"
    return f"{h}:{m:02}:{s:02}" if h else f"{m:02}:{s:02}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording")
    ap.add_argument("--model", default="small.en", help="tiny.en / base.en / small.en / medium.en (bigger = slower, better)")
    ap.add_argument("--out-dir")
    a = ap.parse_args(argv)
    src = Path(a.recording)
    if not src.exists():
        raise SystemExit(f"no file at {src}")
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise SystemExit("faster-whisper isn't installed. Run: python3 -m pip install faster-whisper")
    out = Path(a.out_dir) if a.out_dir else src.parent
    out.mkdir(parents=True, exist_ok=True)
    print(f"Transcribing {src.name} with {a.model} on CPU. A 30 minute call takes a few minutes.", flush=True)
    model = WhisperModel(a.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(src), vad_filter=True, beam_size=5)
    txt, srt = [], []
    for i, seg in enumerate(segments, 1):
        line = seg.text.strip()
        txt.append(f"[{stamp(seg.start)}] {line}")
        srt.append(f"{i}\n{stamp(seg.start, True)} --> {stamp(seg.end, True)}\n{line}\n")
    (out / "transcript.txt").write_text("\n".join(txt) + "\n")
    (out / "transcript.srt").write_text("\n".join(srt))
    print(f"Done: {len(txt)} segments, {info.duration / 60:.1f} min of audio -> {out / 'transcript.txt'}")


if __name__ == "__main__":
    sys.exit(main())
