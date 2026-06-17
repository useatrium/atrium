import importlib.util
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "artifact_capture.py"
SPEC = importlib.util.spec_from_file_location("artifact_capture", MODULE_PATH)
artifact_capture = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = artifact_capture
SPEC.loader.exec_module(artifact_capture)


def test_classifies_artifacts_and_junk(tmp_path):
    image = tmp_path / "chart.png"
    image.write_bytes(b"\x89PNG\r\n")
    junk = tmp_path / "build" / "main.o"
    junk.parent.mkdir()
    junk.write_bytes(b"object")

    decision = artifact_capture.classify_file(
        image, image.stat().st_size, image.read_bytes(), 100
    )
    assert decision.surface is True
    assert decision.stage_bytes is True
    assert decision.mime == "image/png"

    decision = artifact_capture.classify_file(
        junk, junk.stat().st_size, junk.read_bytes(), 100
    )
    assert decision.surface is False
    assert decision.reason in {"path_denied", "junk_extension"}


def test_size_cap_sends_manifest_only(tmp_path, monkeypatch):
    monkeypatch.setenv("CENTAUR_EXECUTION_ID", "exe-test")
    monkeypatch.setenv("CENTAUR_THREAD_KEY", "test:thread")
    path = tmp_path / "large.pdf"
    path.write_bytes(b"x" * 16)
    sent = []
    capture = artifact_capture.ArtifactCapture(
        api_url="http://api",
        api_key="key",
        dirs=[str(tmp_path)],
        max_bytes=4,
        sender=lambda artifact, execution_id, thread_key: sent.append(
            (artifact, execution_id, thread_key)
        ),
    )

    capture.scan_once()

    assert len(sent) == 1
    artifact, execution_id, thread_key = sent[0]
    assert execution_id == "exe-test"
    assert thread_key == "test:thread"
    assert artifact.path == str(path)
    assert artifact.data is None


def test_sha_dedup_skips_same_content(tmp_path, monkeypatch):
    monkeypatch.setenv("CENTAUR_EXECUTION_ID", "exe-test")
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("same")
    second.write_text("same")
    sent = []
    capture = artifact_capture.ArtifactCapture(
        api_url="http://api",
        api_key="key",
        dirs=[str(tmp_path)],
        sender=lambda artifact, _execution_id, _thread_key: sent.append(artifact),
    )

    capture.scan_once()

    assert [Path(artifact.path).name for artifact in sent] == ["first.txt"]


def test_symlinked_files_are_skipped(tmp_path, monkeypatch):
    monkeypatch.setenv("CENTAUR_EXECUTION_ID", "exe-test")
    real = tmp_path / "real.txt"
    real.write_text("hello")
    link = tmp_path / "link.txt"
    link.symlink_to(real)
    sent = []
    capture = artifact_capture.ArtifactCapture(
        api_url="http://api",
        api_key="key",
        dirs=[str(tmp_path)],
        sender=lambda artifact, _execution_id, _thread_key: sent.append(artifact),
    )

    capture.scan_once()

    assert [Path(artifact.path).name for artifact in sent] == ["real.txt"]


def test_secret_deeper_than_sample_window_is_skipped(tmp_path, monkeypatch):
    monkeypatch.setenv("CENTAUR_EXECUTION_ID", "exe-test")
    path = tmp_path / "report.txt"
    # Pad past the 64 KiB sample window so the secret is only visible to the
    # full-payload rescan, not the classify-time sample scan.
    padding = b"a" * (artifact_capture.SECRET_SCAN_BYTES + 1024)
    path.write_bytes(padding + b"\nOPENAI_API_KEY=sk-deadbeefdeadbeefdeadbeef\n")
    sent = []
    capture = artifact_capture.ArtifactCapture(
        api_url="http://api",
        api_key="key",
        dirs=[str(tmp_path)],
        sender=lambda artifact, _execution_id, _thread_key: sent.append(artifact),
    )

    capture.scan_once()

    assert sent == []


def test_secret_names_and_content_are_never_surfaced(tmp_path, monkeypatch):
    monkeypatch.setenv("CENTAUR_EXECUTION_ID", "exe-test")
    env_file = tmp_path / ".env"
    key_file = tmp_path / "notes.txt"
    env_file.write_text("SAFE=value")
    key_file.write_text("OPENAI_API_KEY=sk-secretsecretsecretsecret")
    sent = []
    capture = artifact_capture.ArtifactCapture(
        api_url="http://api",
        api_key="key",
        dirs=[str(tmp_path)],
        sender=lambda artifact, _execution_id, _thread_key: sent.append(artifact),
    )

    capture.scan_once()

    assert sent == []
