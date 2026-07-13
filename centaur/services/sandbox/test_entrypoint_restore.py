from __future__ import annotations

import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ENTRYPOINT = Path(__file__).with_name("entrypoint.sh")


def restore_function() -> str:
    source = ENTRYPOINT.read_text()
    start = source.index("restore_harness_transcript() {")
    end = source.index('\n}\n\nrestore_harness_transcript "$@"', start) + 2
    return source[start:end]


class EntrypointTranscriptRestoreTest(unittest.TestCase):
    def run_codex_restore(self, status: int) -> tuple[str, Path]:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        home = root / "home"
        home.mkdir()
        bin_dir = root / "bin"
        bin_dir.mkdir()
        curl = bin_dir / "curl"
        curl.write_text(
            textwrap.dedent(
                """\
                #!/bin/bash
                while [ "$#" -gt 0 ]; do
                    if [ "$1" = "-o" ]; then
                        output="$2"
                        shift 2
                    else
                        shift
                    fi
                done
                if [ "$MOCK_HTTP_STATUS" = "200" ]; then
                    printf '%s\n' '{"type":"session_meta","payload":{"id":"codex-thread-1"}}' > "$output"
                fi
                printf '%s' "$MOCK_HTTP_STATUS"
                """
            )
        )
        curl.chmod(0o755)
        script = root / "restore.sh"
        script.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/bash
                set -e
                HOME_DIR="$TEST_HOME"
                flat_home_enabled() {{ return 1; }}
                {restore_function()}
                restore_harness_transcript harness-server codex
                printf 'continue=%s\n' "${{CODEX_CONTINUE_THREAD_ID-unset}}"
                """
            )
        )
        result = subprocess.run(
            ["bash", str(script)],
            check=True,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "TEST_HOME": str(home),
                "CENTAUR_HARNESS_TRANSCRIPT_RESTORE": "1",
                "CENTAUR_HARNESS_TYPE": "codex",
                "CENTAUR_THREAD_KEY": "atrium-session-1",
                "CENTAUR_RESUME_THREAD_ID": "codex-thread-1",
                "CENTAUR_API_URL": "https://atrium.invalid",
                "CENTAUR_API_KEY": "sandbox-token",
                "CODEX_CONTINUE_THREAD_ID": "stale-thread-id",
                "MOCK_HTTP_STATUS": str(status),
            },
        )
        return result.stdout, home

    def test_codex_404_restore_falls_back_to_fresh_thread(self) -> None:
        stdout, home = self.run_codex_restore(404)

        self.assertIn("continue=unset", stdout)
        self.assertEqual(list((home / ".codex").rglob("rollout-*.jsonl")), [])

    def test_codex_unavailable_restore_falls_back_to_fresh_thread(self) -> None:
        stdout, _home = self.run_codex_restore(503)

        self.assertIn("continue=unset", stdout)

    def test_codex_successful_restore_enables_resume(self) -> None:
        stdout, home = self.run_codex_restore(200)

        self.assertIn("continue=codex-thread-1", stdout)
        rollouts = list((home / ".codex").rglob("rollout-codex-thread-1.jsonl"))
        self.assertEqual(len(rollouts), 1)
        self.assertIn('"id":"codex-thread-1"', rollouts[0].read_text())


if __name__ == "__main__":
    unittest.main()
