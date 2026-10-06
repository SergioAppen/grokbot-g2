#!/usr/bin/env python3
"""Long-lived local Whisper worker for the relay (faster-whisper, CPU, int8). The relay starts it on demand.
Protocol: one JSON object per line on stdin {"id", "path", "lang"} -> one per line on stdout {"id", "text"} or {"id", "error"}.
Env: WHISPER_MODEL_NAME (tiny|base|small|medium…, default base), WHISPER_MODEL_DIR (download cache), WHISPER_THREADS,
WHISPER_COMPUTE (default float32; int8 is smaller but gave empty/garbled text on our test CPU, so try it before relying on it)."""
import json, os, sys, time, wave
import numpy as np
from faster_whisper import WhisperModel


def load_wav(path):
    """Read a 16-bit PCM WAV (what the relay writes) without PyAV/ffmpeg -> float32 mono at 16 kHz."""
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM WAV")
        rate, ch = w.getframerate(), w.getnchannels()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if rate != 16000:  # simple linear resample; the G2 already sends 16 kHz
        n = int(len(a) * 16000 / rate)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a


name = os.environ.get("WHISPER_MODEL_NAME", "base")
compute = os.environ.get("WHISPER_COMPUTE", "float32")
t0 = time.time()
model = WhisperModel(name, device="cpu", compute_type=compute, cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
                     download_root=os.environ.get("WHISPER_MODEL_DIR") or None)
print(f"whisper model {name} ({compute}) loaded in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    try:
        path = req["path"]
        try:
            audio = load_wav(path)
        except Exception:  # not a plain PCM WAV (e.g. phone mic upload): let faster-whisper decode it
            audio = path
        segs, _info = model.transcribe(audio, language=req.get("lang") or None, beam_size=1, vad_filter=True)
        text = " ".join(s.text.strip() for s in segs).strip()
        out = {"id": req.get("id"), "text": text}
    except Exception as e:  # report, keep serving
        out = {"id": req.get("id"), "error": str(e)[:300]}
    sys.stdout.write(json.dumps(out) + "\n"); sys.stdout.flush()
