"""Nano Banana (Gemini Image Generation) client."""

from io import BytesIO
from pathlib import Path

from google import genai
from google.genai import types
from PIL import Image

from centaur_sdk import secret

MODELS = {
    "flash": "gemini-2.5-flash-image",
    "pro": "gemini-3-pro-image-preview",
}

DEFAULT_MODEL = "flash"


class NanoBananaClient:
    """Client for Google Gemini image generation (Nano Banana).

    Supports both Gemini 2.5 Flash Image (fast) and Gemini 3 Pro Image Preview (high quality).
    """

    def __init__(self, api_key: str | None = None):
        """Initialize the Nano Banana client.

        Args:
            api_key: Optional API key. If not provided, will check GOOGLE_API_KEY env var.
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
        """Get or create the genai client."""
        if self._client is None:
            api_key = self._get_api_key()
            self._client = genai.Client(api_key=api_key)
        return self._client

    def list_models(self) -> dict[str, str]:
        """List available image generation models.

        Returns:
            Dictionary mapping short names to full model IDs.
        """
        return MODELS.copy()

    def generate(
        self,
        prompt: str,
        model: str = DEFAULT_MODEL,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> Image.Image:
        """Generate an image from a text prompt.

        Args:
            prompt: Text description of the image to generate.
            model: Model to use - "flash" (fast) or "pro" (high quality).
            aspect_ratio: Aspect ratio ("1:1", "3:4", "4:3", "9:16", "16:9").
            image_size: Image size for pro model ("1K", "2K", "4K").

        Returns:
            PIL Image object.

        Raises:
            RuntimeError: If image generation fails.
        """
        model_id = MODELS.get(model, model)

        config = {}
        if aspect_ratio:
            config["aspect_ratio"] = aspect_ratio
        if image_size and model == "pro":
            config["image_size"] = image_size

        generate_config = types.GenerateContentConfig(
            response_modalities=["image", "text"],
            **({"generation_config": config} if config else {}),
        )

        response = self.client.models.generate_content(
            model=model_id,
            contents=[prompt],
            config=generate_config,
        )

        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                image_data = part.inline_data.data
                return Image.open(BytesIO(image_data))

        raise RuntimeError("No image was generated. The model returned only text.")

    def edit(
        self,
        image_path: str | Path,
        prompt: str,
        model: str = DEFAULT_MODEL,
        aspect_ratio: str | None = None,
    ) -> Image.Image:
        """Edit an existing image based on a text prompt.

        Args:
            image_path: Path to the input image.
            prompt: Text description of the edit to make.
            model: Model to use - "flash" (fast) or "pro" (high quality).
            aspect_ratio: Aspect ratio for output ("1:1", "3:4", "4:3", "9:16", "16:9").

        Returns:
            PIL Image object with the edits applied.

        Raises:
            RuntimeError: If image editing fails.
            FileNotFoundError: If the input image doesn't exist.
        """
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")

        with open(image_path, "rb") as f:
            image_bytes = f.read()

        suffix = image_path.suffix.lower()
        mime_types = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }
        mime_type = mime_types.get(suffix, "image/png")

        model_id = MODELS.get(model, model)

        config = {}
        if aspect_ratio:
            config["aspect_ratio"] = aspect_ratio

        generate_config = types.GenerateContentConfig(
            response_modalities=["image", "text"],
            **({"generation_config": config} if config else {}),
        )

        image_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)

        response = self.client.models.generate_content(
            model=model_id,
            contents=[image_part, prompt],
            config=generate_config,
        )

        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                image_data = part.inline_data.data
                return Image.open(BytesIO(image_data))

        raise RuntimeError("No image was generated. The model returned only text.")


def _client() -> NanoBananaClient:
    return NanoBananaClient()
