"""Transcription client with Whisper model support."""

import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

IS_MACOS = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"

MODELS = {
    "tiny": ("mlx-community/whisper-tiny", "tiny"),
    "base": ("mlx-community/whisper-base", "base"),
    "small": ("mlx-community/whisper-small", "small"),
    "medium": ("mlx-community/whisper-medium", "medium"),
    "large": ("mlx-community/whisper-large-v3", "large-v3"),
    "turbo": ("mlx-community/whisper-large-v3-turbo", "large-v3-turbo"),
}
DEFAULT_MODEL = "turbo"
END_PHRASE = "over and out"

HALLUCINATIONS = {
    "thank you",
    "thanks for watching",
    "thanks for listening",
    "subscribe",
    "like and subscribe",
    "see you next time",
    "bye",
    "goodbye",
    "thank you for watching",
    "you",
    ".",
    "",
    " ",
}


class TranscriberClient:
    """Local-first voice transcription using Whisper models."""

    def __init__(self):
        self._model_cache: dict = {}

    def get_model_name(self, model: str) -> str:
        """Get platform-specific model name."""
        if model in MODELS:
            return MODELS[model][0] if IS_MACOS else MODELS[model][1]
        return model

    def find_recorder(self) -> str:
        """Find available audio recorder."""
        if shutil.which("sox") or shutil.which("rec"):
            return "sox"
        if shutil.which("ffmpeg"):
            return "ffmpeg"
        if shutil.which("arecord"):
            return "arecord"
        raise RuntimeError(
            "No audio recorder found. Install sox: "
            + ("brew install sox" if IS_MACOS else "apt install sox")
        )

    def get_default_audio_device(self) -> str:
        """Get the default audio input device index for macOS."""
        if not IS_MACOS:
            return "default"

        result = subprocess.run(
            ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
            capture_output=True,
            text=True,
        )
        output = result.stderr

        in_audio = False
        for line in output.split("\n"):
            if "audio devices" in line.lower():
                in_audio = True
                continue
            if in_audio:
                match = re.search(r"\[(\d+)\]\s+(.+)", line)
                if match:
                    idx, name = match.groups()
                    name_lower = name.lower()
                    if "microphone" in name_lower and "virtual" not in name_lower:
                        return f":{idx}"

        return ":1"

    def _record_chunk_ffmpeg(self, output: Path, duration: float):
        """Record a chunk of audio using ffmpeg."""
        if IS_MACOS:
            device = self.get_default_audio_device()
            input_device = ["-f", "avfoundation", "-i", device]
        else:
            input_device = ["-f", "alsa", "-i", "default"]

        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "quiet",
            *input_device,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-acodec",
            "pcm_s16le",
            "-t",
            str(duration),
            str(output),
        ]
        subprocess.run(cmd, check=True, capture_output=True)

    def _record_chunk_sox(self, output: Path, duration: float):
        """Record a chunk using sox."""
        cmd = [
            "rec",
            "-q",
            "-r",
            "16000",
            "-c",
            "1",
            "-b",
            "16",
            str(output),
            "trim",
            "0",
            str(duration),
        ]
        subprocess.run(cmd, check=True, capture_output=True)

    def record_chunk(self, output: Path, duration: float):
        """Record a chunk of audio."""
        recorder = self.find_recorder()
        if recorder == "sox":
            self._record_chunk_sox(output, duration)
        else:
            self._record_chunk_ffmpeg(output, duration)

    def is_hallucination(self, text: str) -> bool:
        """Check if text is a known Whisper hallucination."""
        cleaned = text.lower().strip().rstrip(".!?,")
        return cleaned in HALLUCINATIONS or len(cleaned) < 2

    def get_whisper_model(self, model: str):
        """Get or create cached Whisper model."""
        model_name = self.get_model_name(model)

        if model_name in self._model_cache:
            return self._model_cache[model_name]

        if IS_MACOS:
            import mlx_whisper

            tmp = Path(tempfile.mktemp(suffix=".wav"))
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=16000:cl=mono",
                    "-t",
                    "0.1",
                    "-acodec",
                    "pcm_s16le",
                    str(tmp),
                ],
                capture_output=True,
                check=True,
            )
            try:
                mlx_whisper.transcribe(str(tmp), path_or_hf_repo=model_name)
            finally:
                tmp.unlink(missing_ok=True)
            self._model_cache[model_name] = ("mlx", model_name)
        else:
            from faster_whisper import WhisperModel

            whisper = WhisperModel(model_name, device="auto", compute_type="auto")
            self._model_cache[model_name] = ("faster", whisper)

        return self._model_cache[model_name]

    def transcribe_audio(self, path: Path | str, model: str = DEFAULT_MODEL, language: Optional[str] = None) -> str:
        """Transcribe audio file."""
        path = Path(path)
        cached = self.get_whisper_model(model)

        if cached[0] == "mlx":
            import mlx_whisper

            result = mlx_whisper.transcribe(
                str(path),
                path_or_hf_repo=cached[1],
                language=language,
                condition_on_previous_text=False,
            )
            text = result["text"].strip()
        else:
            whisper = cached[1]
            segments, _ = whisper.transcribe(
                str(path),
                language=language,
                condition_on_previous_text=False,
            )
            text = " ".join(seg.text for seg in segments).strip()

        return "" if self.is_hallucination(text) else text

    def transcribe_file(self, path: Path | str, model: str = DEFAULT_MODEL, language: Optional[str] = None) -> str:
        """Higher-level file transcription with validation."""
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        return self.transcribe_audio(path, model, language)

    def merge_wav_files(self, files: list[Path], output: Path):
        """Merge multiple WAV files into one."""
        if not files:
            return

        if len(files) == 1:
            shutil.copy(files[0], output)
            return

        if shutil.which("sox"):
            cmd = ["sox"] + [str(f) for f in files] + [str(output)]
            subprocess.run(cmd, check=True, capture_output=True)
        else:
            list_file = output.parent / "concat.txt"
            with open(list_file, "w") as f:
                for file in files:
                    f.write(f"file '{file}'\n")
            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                str(output),
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            list_file.unlink(missing_ok=True)

    def list_models(self) -> list[dict]:
        """Return available models info."""
        model_info = [
            ("tiny", "~75MB", "Fastest, least accurate"),
            ("base", "~140MB", "Fast, basic accuracy"),
            ("small", "~460MB", "Good balance"),
            ("medium", "~1.5GB", "High accuracy"),
            ("large", "~3GB", "Best accuracy"),
            ("turbo", "~1.6GB", "Best speed/accuracy (default)"),
        ]
        backend = "MLX" if IS_MACOS else "faster-whisper"
        result = []
        for name, size, desc in model_info:
            mlx_name, fw_name = MODELS[name]
            actual = mlx_name if IS_MACOS else fw_name
            result.append(
                {
                    "name": name,
                    "model_id": actual,
                    "size": size,
                    "description": desc,
                    "backend": backend,
                }
            )
        return result


def _client() -> TranscriberClient:
    return TranscriberClient()
