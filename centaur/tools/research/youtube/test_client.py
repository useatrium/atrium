import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.research.youtube.client import YouTubeClient


def test_get_transcript_supports_urls_and_negative_time_slices():
    video_id = "abc123def45"
    transcript_xml = """
    <transcript>
      <text start="0.0" dur="5.0">Intro</text>
      <text start="10.0" dur="5.0">Middle</text>
      <text start="20.0" dur="8.0">Wrap up</text>
    </transcript>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/watch":
            return httpx.Response(
                200,
                request=request,
                text='{"INNERTUBE_API_KEY":"inner-tube-key"}',
            )
        if request.method == "POST" and request.url.path == "/youtubei/v1/player":
            return httpx.Response(
                200,
                request=request,
                json={
                    "playabilityStatus": {"status": "OK"},
                    "captions": {
                        "playerCaptionsTracklistRenderer": {
                            "captionTracks": [
                                {
                                    "baseUrl": f"https://www.youtube.com/api/timedtext?v={video_id}",
                                    "name": {"simpleText": "English"},
                                    "languageCode": "en",
                                    "isTranslatable": True,
                                }
                            ]
                        }
                    },
                },
            )
        if request.method == "GET" and request.url.path == "/api/timedtext":
            return httpx.Response(200, request=request, text=transcript_xml)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = YouTubeClient(timeout=5)
    client._client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)

    try:
        data = client.get_transcript(
            f"https://www.youtube.com/watch?v={video_id}",
            start_time="-00:00:20",
            end_time="-00:00:05",
        )
    finally:
        client.close()

    assert data["video_id"] == video_id
    assert data["window_start"] == 8.0
    assert data["window_end"] == 23.0
    assert [row["text"] for row in data["transcript"]] == ["Middle", "Wrap up"]
    assert data["text"] == "Middle Wrap up"


def test_get_transcript_raises_clear_error_when_no_public_captions_exist():
    video_id = "abc123def45"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/watch":
            return httpx.Response(
                200,
                request=request,
                text='{"INNERTUBE_API_KEY":"inner-tube-key"}',
            )
        if request.method == "POST" and request.url.path == "/youtubei/v1/player":
            return httpx.Response(
                200,
                request=request,
                json={"playabilityStatus": {"status": "OK"}},
            )
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = YouTubeClient(timeout=5)
    client._client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)

    try:
        with pytest.raises(RuntimeError, match="No public captions are available for this video"):
            client.get_transcript(video_id)
    finally:
        client.close()
