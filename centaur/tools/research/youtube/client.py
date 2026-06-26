"""YouTube Data API client."""

import re
import subprocess
import urllib.parse
from html import unescape
from xml.etree import ElementTree

import httpx

from centaur_sdk import secret

_WATCH_URL = "https://www.youtube.com/watch?v={video_id}"
_INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player"
_INNERTUBE_CONTEXT = {"client": {"clientName": "ANDROID", "clientVersion": "20.10.38"}}
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_INNERTUBE_API_KEY_RE = re.compile(r'"INNERTUBE_API_KEY":\s*"([A-Za-z0-9_-]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


class YouTubeClient:
    """Client for YouTube Data API v3."""

    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self._api_key = api_key
        self.base_url = "https://www.googleapis.com/youtube/v3"
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                timeout=self.timeout,
                follow_redirects=True,
                headers={"Accept-Language": "en-US"},
            )
        return self._client

    def _normalize_video_id(self, video_id_or_url: str) -> str:
        """Accept a bare video ID or a common YouTube URL."""
        candidate = video_id_or_url.strip()
        if _VIDEO_ID_RE.fullmatch(candidate):
            return candidate

        parsed = urllib.parse.urlparse(candidate)
        host = (parsed.hostname or "").lower()
        path_parts = [part for part in parsed.path.split("/") if part]

        if host == "youtu.be" and path_parts:
            candidate = path_parts[0]
        elif host.endswith("youtube.com"):
            if parsed.path == "/watch":
                candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
            elif len(path_parts) >= 2 and path_parts[0] in {"embed", "live", "shorts", "v"}:
                candidate = path_parts[1]
            else:
                candidate = ""
        else:
            candidate = ""

        if _VIDEO_ID_RE.fullmatch(candidate):
            return candidate
        raise RuntimeError(f"Invalid YouTube video ID or URL: {video_id_or_url}")

    def _extract_api_key(self, html: str) -> str:
        match = _INNERTUBE_API_KEY_RE.search(html)
        if match:
            return match.group(1)
        raise RuntimeError("Could not resolve YouTube transcript metadata.")

    def _fetch_watch_html(self, video_id: str) -> str:
        try:
            response = self.client.get(_WATCH_URL.format(video_id=video_id))
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"YouTube transcript metadata request failed: {e.response.status_code}"
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"YouTube transcript metadata request failed: {e}") from e

        html = unescape(response.text)
        if 'action="https://consent.youtube.com/s"' not in html:
            return html

        consent_match = re.search(r'name="v" value="(.*?)"', html)
        if consent_match is None:
            raise RuntimeError("YouTube transcript retrieval was blocked by a consent wall.")

        self.client.cookies.set("CONSENT", f"YES+{consent_match.group(1)}", domain=".youtube.com")
        try:
            response = self.client.get(_WATCH_URL.format(video_id=video_id))
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"YouTube transcript metadata request failed: {e.response.status_code}"
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"YouTube transcript metadata request failed: {e}") from e

        html = unescape(response.text)
        if 'action="https://consent.youtube.com/s"' in html:
            raise RuntimeError("YouTube transcript retrieval was blocked by a consent wall.")
        return html

    def _fetch_player_response(self, video_id: str) -> dict:
        html = self._fetch_watch_html(video_id)
        api_key = self._extract_api_key(html)
        try:
            response = self.client.post(
                _INNERTUBE_API_URL,
                params={"key": api_key},
                json={"context": _INNERTUBE_CONTEXT, "videoId": video_id},
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"YouTube transcript discovery failed: {e.response.status_code} - {e.response.text}"
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"YouTube transcript discovery failed: {e}") from e

    def _fetch_caption_tracks(self, video_id: str) -> list[dict]:
        data = self._fetch_player_response(video_id)
        playability = data.get("playabilityStatus", {})
        status = playability.get("status")
        if status and status != "OK":
            reason = playability.get("reason") or status
            raise RuntimeError(f"YouTube transcript unavailable: {reason}")

        captions = data.get("captions", {}).get("playerCaptionsTracklistRenderer", {})
        tracks = captions.get("captionTracks") or []
        if not tracks:
            raise RuntimeError("No public captions are available for this video.")
        return tracks

    def _track_name(self, track: dict) -> str:
        name = track.get("name") or {}
        if "simpleText" in name:
            return name["simpleText"]
        if "runs" in name:
            return "".join(run.get("text", "") for run in name["runs"])
        return track.get("languageCode", "unknown")

    def _language_matches(self, track_code: str, requested_code: str) -> bool:
        track_code = track_code.lower()
        requested_code = requested_code.lower()
        if track_code == requested_code:
            return True
        track_base = track_code.split("-", 1)[0]
        requested_base = requested_code.split("-", 1)[0]
        return track_base == requested_base

    def _select_caption_track(self, tracks: list[dict], language_codes: list[str] | None) -> dict:
        manual_tracks = [track for track in tracks if track.get("kind") != "asr"]
        generated_tracks = [track for track in tracks if track.get("kind") == "asr"]

        if language_codes:
            for language_code in language_codes:
                for pool in (manual_tracks, generated_tracks):
                    for track in pool:
                        if self._language_matches(track.get("languageCode", ""), language_code):
                            return track
            available = ", ".join(track.get("languageCode", "") for track in tracks)
            raise RuntimeError(
                "No public captions matched the requested languages: "
                f"{', '.join(language_codes)}. Available languages: {available or 'none'}."
            )

        for pool in (manual_tracks, generated_tracks):
            for track in pool:
                if self._language_matches(track.get("languageCode", ""), "en"):
                    return track
        if manual_tracks:
            return manual_tracks[0]
        return generated_tracks[0]

    def _parse_offset(self, value: str | float | int | None) -> float | None:
        if value is None:
            return None
        if isinstance(value, int | float):
            return float(value)

        text = str(value).strip()
        if not text:
            return None

        sign = -1 if text.startswith("-") else 1
        if text[0] in "+-":
            text = text[1:]

        if ":" not in text:
            try:
                return sign * float(text)
            except ValueError as e:
                raise RuntimeError(f"Invalid transcript offset: {value}") from e

        parts = text.split(":")
        if len(parts) > 3 or any(not part.isdigit() for part in parts):
            raise RuntimeError(f"Invalid transcript offset: {value}")

        seconds = 0
        for part in parts:
            seconds = seconds * 60 + int(part)
        return sign * float(seconds)

    def _normalize_window(
        self,
        start_time: float | None,
        end_time: float | None,
        transcript_end: float,
    ) -> tuple[float | None, float | None]:
        resolved_start = (
            transcript_end + start_time if start_time is not None and start_time < 0 else start_time
        )
        resolved_end = (
            transcript_end + end_time if end_time is not None and end_time < 0 else end_time
        )

        if resolved_start is not None:
            resolved_start = max(0.0, resolved_start)
        if resolved_end is not None:
            resolved_end = max(0.0, resolved_end)
        if (
            resolved_start is not None
            and resolved_end is not None
            and resolved_end < resolved_start
        ):
            raise RuntimeError(
                "Transcript end offset must be greater than or equal to the start offset."
            )
        return resolved_start, resolved_end

    def _parse_transcript_xml(self, xml_text: str) -> list[dict]:
        try:
            root = ElementTree.fromstring(xml_text)
        except ElementTree.ParseError as e:
            raise RuntimeError("YouTube returned an unreadable caption document.") from e

        transcript = []
        for node in root.findall("text"):
            text = _TAG_RE.sub("", unescape("".join(node.itertext()))).strip()
            if not text:
                continue
            start = float(node.attrib.get("start", "0") or 0)
            duration = float(node.attrib.get("dur", "0") or 0)
            transcript.append(
                {
                    "text": text,
                    "start": start,
                    "duration": duration,
                    "end": start + duration,
                }
            )
        if not transcript:
            raise RuntimeError("No public captions are available for this video.")
        return transcript

    def list_transcripts(self, video_id: str) -> dict:
        """List the public caption tracks available for a YouTube video."""
        normalized_video_id = self._normalize_video_id(video_id)
        tracks = self._fetch_caption_tracks(normalized_video_id)
        return {
            "video_id": normalized_video_id,
            "tracks": [
                {
                    "language": self._track_name(track),
                    "language_code": track.get("languageCode"),
                    "is_generated": track.get("kind") == "asr",
                    "is_translatable": bool(track.get("isTranslatable")),
                }
                for track in tracks
            ],
        }

    def get_transcript(
        self,
        video_id: str,
        language_codes: list[str] | None = None,
        start_time: str | float | int | None = None,
        end_time: str | float | int | None = None,
    ) -> dict:
        """Fetch a timestamped public transcript for a YouTube video."""
        normalized_video_id = self._normalize_video_id(video_id)
        tracks = self._fetch_caption_tracks(normalized_video_id)
        track = self._select_caption_track(tracks, language_codes)

        transcript_url = (track.get("baseUrl") or "").replace("&fmt=srv3", "")
        if not transcript_url:
            raise RuntimeError("No public captions are available for this video.")
        if "&exp=xpe" in transcript_url:
            raise RuntimeError(
                "YouTube requires extra authorization for this video's public captions."
            )

        try:
            response = self.client.get(transcript_url)
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"YouTube transcript download failed: {e.response.status_code} - {e.response.text}"
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"YouTube transcript download failed: {e}") from e

        transcript = self._parse_transcript_xml(response.text)
        transcript_end = max(segment["end"] for segment in transcript)
        resolved_start, resolved_end = self._normalize_window(
            self._parse_offset(start_time),
            self._parse_offset(end_time),
            transcript_end,
        )

        sliced_transcript = [
            segment
            for segment in transcript
            if (resolved_start is None or segment["end"] > resolved_start)
            and (resolved_end is None or segment["start"] < resolved_end)
        ]
        if not sliced_transcript:
            raise RuntimeError("No transcript entries overlap the requested time range.")

        return {
            "video_id": normalized_video_id,
            "language": self._track_name(track),
            "language_code": track.get("languageCode"),
            "is_generated": track.get("kind") == "asr",
            "window_start": resolved_start,
            "window_end": resolved_end,
            "transcript_start": sliced_transcript[0]["start"],
            "transcript_end": sliced_transcript[-1]["end"],
            "transcript": sliced_transcript,
            "text": " ".join(segment["text"] for segment in sliced_transcript),
        }

    def _get_api_key(self) -> str | None:
        """Get API key from instance, env var, or 1Password."""
        if self._api_key:
            return self._api_key
        key = secret("YOUTUBE_API_KEY", "") or secret("GOOGLE_API_KEY", "")
        if key:
            return key
        try:
            result = subprocess.run(
                ["op", "read", "op://ai-agents/YouTube API Key/credential"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass
        return None

    def _request(
        self,
        endpoint: str,
        params: dict | None = None,
    ) -> dict:
        """Make an API request."""
        api_key = self._get_api_key()
        if not api_key:
            raise RuntimeError("YOUTUBE_API_KEY not set.")

        url = f"{self.base_url}{endpoint}"
        params = {} if params is None else dict(params)
        params["key"] = api_key

        try:
            response = self.client.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}") from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

    def search(
        self,
        query: str,
        max_results: int = 10,
        type: str = "video",
        order: str = "relevance",
    ) -> dict:
        """Search for videos, channels, or playlists."""
        params = {
            "part": "snippet",
            "q": query,
            "maxResults": max_results,
            "type": type,
            "order": order,
        }
        return self._request("/search", params=params)

    def get_video(self, video_id: str) -> dict:
        """Get video details."""
        params = {
            "part": "snippet,contentDetails,statistics",
            "id": video_id,
        }
        return self._request("/videos", params=params)

    def get_channel(self, channel_id: str) -> dict:
        """Get channel details."""
        params = {
            "part": "snippet,statistics",
            "id": channel_id,
        }
        return self._request("/channels", params=params)

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> YouTubeClient:
    return YouTubeClient()
