"""
BetterSubtitle Local GPU Whisper Server
---------------------------------------
Streams 16kHz mono little-endian Int16 PCM audio from the BetterSubtitle browser
extension over WebSocket (/ws/transcribe) and returns real-time interim and
finalized sentence transcripts using faster-whisper or openai-whisper.

Quick start (conda):
    conda run -n premiere_sub --no-capture-output python server/live_whisper_server.py
    # Or with custom model/port:
    python server/live_whisper_server.py --model small --port 8765
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import threading
import time
from typing import Any, Optional, Tuple

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2

# Common Whisper hallucinations emitted on near-silent background noise
HALLUCINATION_SET = {
    "thank you",
    "thank you.",
    "thanks for watching",
    "thanks for watching.",
    "you",
    "you.",
    "mbc",
    "subtitles by the amara.org community",
    "subscribe",
    "bye",
    "bye.",
}


def clean_transcript(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text or "").strip()
    if not cleaned:
        return ""
    if cleaned.lower() in HALLUCINATION_SET:
        return ""
    # Drop pure punctuation or bracket-only noise
    if re.fullmatch(r"[\W_]+", cleaned):
        return ""
    return cleaned


class WhisperEngine:
    def __init__(self, model_name: str = "small", device: str = "auto") -> None:
        self.model_name = model_name
        self.requested_device = device
        self.backend: str = "unloaded"
        self.device: str = "cpu"
        self._model: Any = None
        self._lock = threading.Lock()
        self._load_model()

    def _detect_device(self) -> str:
        if self.requested_device in ("cuda", "cpu"):
            return self.requested_device
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def _load_model(self) -> None:
        self.device = self._detect_device()

        # Prefer faster-whisper if installed (lowest VRAM & fastest CUDA inference)
        try:
            from faster_whisper import WhisperModel  # type: ignore

            compute_type = "float16" if self.device == "cuda" else "int8"
            print(
                f"[BetterSubtitle] Loading faster-whisper '{self.model_name}' "
                f"on {self.device} ({compute_type})..."
            )
            self._model = WhisperModel(
                self.model_name, device=self.device, compute_type=compute_type
            )
            self.backend = "faster-whisper"
            print(f"[BetterSubtitle] Ready: faster-whisper ({self.model_name} on {self.device})")
            return
        except ImportError:
            pass

        # Fallback to openai-whisper (PyTorch)
        try:
            import whisper  # type: ignore

            print(
                f"[BetterSubtitle] Loading openai-whisper '{self.model_name}' "
                f"on {self.device}..."
            )
            self._model = whisper.load_model(self.model_name, device=self.device)
            self.backend = "openai-whisper"
            print(f"[BetterSubtitle] Ready: openai-whisper ({self.model_name} on {self.device})")
            return
        except ImportError as exc:
            raise RuntimeError(
                "Neither 'faster-whisper' nor 'openai-whisper' is installed. "
                "Install one with: pip install faster-whisper (recommended) or pip install openai-whisper"
            ) from exc

    def transcribe(
        self, audio_f32: np.ndarray, language: Optional[str] = None
    ) -> Tuple[str, str]:
        if audio_f32.size < int(SAMPLE_RATE * 0.35):
            return "", language or ""

        lang_arg = None if (not language or language == "auto") else language

        with self._lock:
            if self.backend == "faster-whisper":
                segments, info = self._model.transcribe(
                    audio_f32,
                    language=lang_arg,
                    beam_size=1,
                    vad_filter=True,
                    condition_on_previous_text=False,
                    without_timestamps=True,
                )
                text = " ".join(seg.text.strip() for seg in segments if seg.text)
                detected = getattr(info, "language", "") or (lang_arg or "")
                return clean_transcript(text), detected

            # openai-whisper
            result = self._model.transcribe(
                audio_f32,
                language=lang_arg,
                fp16=(self.device == "cuda"),
                beam_size=1,
                condition_on_previous_text=False,
                no_speech_threshold=0.62,
            )
            text = clean_transcript(str(result.get("text", "")))
            detected = str(result.get("language", "") or (lang_arg or ""))
            return text, detected


def create_app(engine: WhisperEngine) -> FastAPI:
    app = FastAPI(title="BetterSubtitle Local Whisper Server", version="1.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "backend": engine.backend,
            "device": engine.device,
            "model": engine.model_name,
        }

    @app.websocket("/ws/transcribe")
    async def ws_transcribe(websocket: WebSocket, lang: str = "auto") -> None:
        await websocket.accept()
        loop = asyncio.get_running_loop()

        pcm_chunks: list[np.ndarray] = []
        total_samples = 0
        has_speech = False
        last_speech_at = 0.0
        last_interim_at = 0.0
        last_interim_text = ""

        # Tuning thresholds for smooth livestream responsiveness
        vad_rms_threshold = 0.012
        pause_finalize_sec = 0.85
        max_utterance_sec = 6.0
        interim_interval_sec = 1.35
        min_speech_sec = 0.55

        async def run_and_send(is_final: bool) -> None:
            nonlocal pcm_chunks, total_samples, has_speech, last_interim_text
            if total_samples < int(SAMPLE_RATE * min_speech_sec):
                if is_final:
                    pcm_chunks = []
                    total_samples = 0
                    has_speech = False
                    last_interim_text = ""
                return

            audio = np.concatenate(pcm_chunks)
            if is_final:
                pcm_chunks = []
                total_samples = 0
                has_speech = False

            text, detected_lang = await loop.run_in_executor(
                None, engine.transcribe, audio, lang
            )

            if not text:
                if is_final:
                    last_interim_text = ""
                return

            if not is_final and text == last_interim_text:
                return

            last_interim_text = "" if is_final else text
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "final" if is_final else "interim",
                        "text": text,
                        "language": detected_lang,
                    },
                    ensure_ascii=False,
                )
            )

        try:
            while True:
                ws_msg = await websocket.receive()
                if ws_msg.get("type") == "websocket.disconnect":
                    return
                raw_bytes = ws_msg.get("bytes")
                if not raw_bytes:
                    continue
                valid_len = len(raw_bytes) - (len(raw_bytes) % BYTES_PER_SAMPLE)
                if valid_len <= 0:
                    continue

                samples = (
                    np.frombuffer(raw_bytes[:valid_len], dtype=np.int16).astype(np.float32)
                    / 32768.0
                )
                rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
                now = time.monotonic()

                if rms >= vad_rms_threshold:
                    has_speech = True
                    last_speech_at = now
                    pcm_chunks.append(samples)
                    total_samples += samples.size
                elif has_speech:
                    # Keep brief trailing silence for natural Whisper ending
                    pcm_chunks.append(samples)
                    total_samples += samples.size

                if not has_speech:
                    continue

                duration_sec = total_samples / SAMPLE_RATE
                silence_sec = now - last_speech_at

                if silence_sec >= pause_finalize_sec or duration_sec >= max_utterance_sec:
                    await run_and_send(is_final=True)
                    last_interim_at = now
                elif (
                    duration_sec >= 1.2
                    and (now - last_interim_at) >= interim_interval_sec
                ):
                    await run_and_send(is_final=False)
                    last_interim_at = now

        except WebSocketDisconnect:
            return
        except Exception as exc:
            try:
                await websocket.send_text(
                    json.dumps({"type": "error", "error": str(exc)})
                )
            except Exception:
                pass

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="BetterSubtitle Local Whisper Server")
    parser.add_argument(
        "--model",
        default="small",
        help="Whisper model size (tiny, base, small, medium, large-v3-turbo). Default: small",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="Inference device. Default: auto",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="Bind port. Default: 8765")
    args = parser.parse_args()

    engine = WhisperEngine(model_name=args.model, device=args.device)
    app = create_app(engine)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
