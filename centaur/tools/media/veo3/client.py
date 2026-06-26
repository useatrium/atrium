"""Veo 3 video generation client."""

import time
from collections.abc import Callable
from pathlib import Path

from google import genai
from google.genai import types

from centaur_sdk import secret


class Veo3Client:
    """Client for Google's Veo 3 video generation API.

    Uses the google-genai SDK to generate videos from text prompts or images.
    """

    MODELS = {
        "full": "veo-3.1-generate-preview",
        "fast": "veo-3.1-fast-generate-preview",
    }

    ASPECT_RATIOS = ["16:9", "9:16", "1:1"]
    RESOLUTIONS = ["720p", "1080p", "4k"]

    def __init__(self, api_key: str | None = None):
        """Initialize the Veo 3 client.

        Args:
            api_key: Optional API key. Falls back to env var.
        """
        self._api_key = api_key
        self._client: genai.Client | None = None

    def _get_api_key(self) -> str:
        """Get API key from instance or env var."""
        if self._api_key:
            return self._api_key
        key = secret("GOOGLE_API_KEY", "")
        if key:
            return key
        raise RuntimeError("GOOGLE_API_KEY not set.")

    @property
    def client(self) -> genai.Client:
        if self._client is None:
            self._client = genai.Client(api_key=self._get_api_key())
        return self._client

    def list_models(self) -> list[dict]:
        """List available Veo models.

        Returns:
            List of model info dicts with name, id, and description.
        """
        return [
            {
                "name": "full",
                "id": self.MODELS["full"],
                "description": "Highest quality video generation (slower)",
            },
            {
                "name": "fast",
                "id": self.MODELS["fast"],
                "description": "Fast video generation (lower quality)",
            },
        ]

    def generate(
        self,
        prompt: str,
        output: str | Path,
        model: str = "full",
        aspect_ratio: str = "16:9",
        resolution: str = "720p",
        poll_interval: float = 20.0,
        progress_callback: Callable | None = None,
    ) -> Path:
        """Generate a video from a text prompt.

        Args:
            prompt: Text description of the video to generate.
            output: Output file path for the generated video.
            model: Model to use ("full" or "fast").
            aspect_ratio: Aspect ratio ("16:9", "9:16", or "1:1").
            resolution: Resolution ("720p", "1080p", or "4k").
            poll_interval: Seconds between polling for completion.
            progress_callback: Optional callback for progress updates.

        Returns:
            Path to the generated video file.

        Raises:
            ValueError: If invalid model, aspect_ratio, or resolution.
            RuntimeError: If generation fails.
        """
        if model not in self.MODELS:
            raise ValueError(f"Invalid model: {model}. Choose from: {list(self.MODELS.keys())}")
        if aspect_ratio not in self.ASPECT_RATIOS:
            raise ValueError(
                f"Invalid aspect_ratio: {aspect_ratio}. Choose from: {self.ASPECT_RATIOS}"
            )
        if resolution not in self.RESOLUTIONS:
            raise ValueError(f"Invalid resolution: {resolution}. Choose from: {self.RESOLUTIONS}")

        model_id = self.MODELS[model]
        output_path = Path(output)

        if progress_callback:
            progress_callback(f"Starting generation with {model_id}...")

        operation = self.client.models.generate_videos(
            model=model_id,
            prompt=prompt,
            config=types.GenerateVideosConfig(
                aspect_ratio=aspect_ratio,
                resolution=resolution,
            ),
        )

        while not operation.done:
            if progress_callback:
                progress_callback("Generating video...")
            time.sleep(poll_interval)
            operation = self.client.operations.get(operation)

        if not operation.response or not operation.response.generated_videos:
            raise RuntimeError("Video generation failed: no videos returned")

        generated_video = operation.response.generated_videos[0]

        if progress_callback:
            progress_callback("Downloading video...")

        self.client.files.download(file=generated_video.video)
        generated_video.video.save(str(output_path))

        return output_path

    def generate_from_image(
        self,
        image_path: str | Path,
        prompt: str,
        output: str | Path,
        model: str = "full",
        aspect_ratio: str = "16:9",
        resolution: str = "720p",
        poll_interval: float = 20.0,
        progress_callback: Callable | None = None,
    ) -> Path:
        """Generate a video using an image as the first frame.

        Args:
            image_path: Path to the input image (first frame).
            prompt: Text description of what should happen in the video.
            output: Output file path for the generated video.
            model: Model to use ("full" or "fast").
            aspect_ratio: Aspect ratio ("16:9", "9:16", or "1:1").
            resolution: Resolution ("720p", "1080p", or "4k").
            poll_interval: Seconds between polling for completion.
            progress_callback: Optional callback for progress updates.

        Returns:
            Path to the generated video file.

        Raises:
            ValueError: If invalid parameters.
            RuntimeError: If generation fails.
        """
        if model not in self.MODELS:
            raise ValueError(f"Invalid model: {model}. Choose from: {list(self.MODELS.keys())}")
        if aspect_ratio not in self.ASPECT_RATIOS:
            raise ValueError(
                f"Invalid aspect_ratio: {aspect_ratio}. Choose from: {self.ASPECT_RATIOS}"
            )
        if resolution not in self.RESOLUTIONS:
            raise ValueError(f"Invalid resolution: {resolution}. Choose from: {self.RESOLUTIONS}")

        image_path = Path(image_path)
        if not image_path.exists():
            raise ValueError(f"Image not found: {image_path}")

        model_id = self.MODELS[model]
        output_path = Path(output)

        if progress_callback:
            progress_callback(f"Uploading image and starting generation with {model_id}...")

        uploaded_image = self.client.files.upload(file=image_path)

        operation = self.client.models.generate_videos(
            model=model_id,
            prompt=prompt,
            image=uploaded_image,
            config=types.GenerateVideosConfig(
                aspect_ratio=aspect_ratio,
                resolution=resolution,
            ),
        )

        while not operation.done:
            if progress_callback:
                progress_callback("Generating video...")
            time.sleep(poll_interval)
            operation = self.client.operations.get(operation)

        if not operation.response or not operation.response.generated_videos:
            raise RuntimeError("Video generation failed: no videos returned")

        generated_video = operation.response.generated_videos[0]

        if progress_callback:
            progress_callback("Downloading video...")

        self.client.files.download(file=generated_video.video)
        generated_video.video.save(str(output_path))

        return output_path

    def extend(
        self,
        video_path: str | Path,
        prompt: str,
        output: str | Path,
        model: str = "full",
        poll_interval: float = 20.0,
        progress_callback: Callable | None = None,
    ) -> Path:
        """Extend an existing video with additional content.

        Args:
            video_path: Path to the input video to extend.
            prompt: Text description of what should happen next.
            output: Output file path for the extended video.
            model: Model to use ("full" or "fast").
            poll_interval: Seconds between polling for completion.
            progress_callback: Optional callback for progress updates.

        Returns:
            Path to the generated video file.

        Raises:
            ValueError: If invalid parameters.
            RuntimeError: If generation fails.
        """
        if model not in self.MODELS:
            raise ValueError(f"Invalid model: {model}. Choose from: {list(self.MODELS.keys())}")

        video_path = Path(video_path)
        if not video_path.exists():
            raise ValueError(f"Video not found: {video_path}")

        model_id = self.MODELS[model]
        output_path = Path(output)

        if progress_callback:
            progress_callback(f"Uploading video and starting extension with {model_id}...")

        uploaded_video = self.client.files.upload(file=video_path)

        operation = self.client.models.generate_videos(
            model=model_id,
            prompt=prompt,
            video=uploaded_video,
        )

        while not operation.done:
            if progress_callback:
                progress_callback("Generating video extension...")
            time.sleep(poll_interval)
            operation = self.client.operations.get(operation)

        if not operation.response or not operation.response.generated_videos:
            raise RuntimeError("Video extension failed: no videos returned")

        generated_video = operation.response.generated_videos[0]

        if progress_callback:
            progress_callback("Downloading video...")

        self.client.files.download(file=generated_video.video)
        generated_video.video.save(str(output_path))

        return output_path


def _client() -> Veo3Client:
    return Veo3Client()
