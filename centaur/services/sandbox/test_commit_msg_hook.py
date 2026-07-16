from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


HOOK = Path(__file__).with_name("git-hooks") / "commit-msg"


class CommitMsgHookTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.repo = Path(temp_dir.name) / "repo"
        self.repo.mkdir()
        self.env = {
            **os.environ,
            "BASH_ENV": "/dev/null",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.git("init", "-q", "-b", "main", check=True)
        self.git("config", "user.name", "Test User", check=True)
        self.git("config", "user.email", "test@example.com", check=True)
        self.git("config", "core.hooksPath", str(HOOK.parent), check=True)

    def git(
        self, *args: str, check: bool = False, input: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            env=self.env,
            input=input,
            text=True,
            capture_output=True,
            check=check,
        )

    def commit_message(self) -> str:
        return self.git("log", "-1", "--pretty=%B", check=True).stdout.rstrip("\n")

    def test_appends_trailers_once_and_amend_is_idempotent(self) -> None:
        self.git(
            "config",
            "atrium.sessionId",
            "de230f34-b9d9-42df-bce3-9270f2184294",
            check=True,
        )
        self.git("config", "atrium.harness", "claude", check=True)
        (self.repo / "example.txt").write_text("content\n")
        self.git("add", "example.txt", check=True)

        self.git("commit", "-m", "feat: add provenance", check=True)
        message = self.commit_message()
        self.assertEqual(message.count("Atrium-Session:"), 1)
        self.assertEqual(message.count("Atrium-Harness:"), 1)
        self.assertTrue(
            message.endswith(
                "\n\nAtrium-Session: de230f34-b9d9-42df-bce3-9270f2184294\n"
                "Atrium-Harness: claude"
            )
        )

        self.git("commit", "--amend", "--no-edit", check=True)
        amended = self.commit_message()
        self.assertEqual(amended.count("Atrium-Session:"), 1)
        self.assertEqual(amended.count("Atrium-Harness:"), 1)

    def test_missing_atrium_config_leaves_message_unchanged(self) -> None:
        original = "feat: preserve this message\n\nBody remains unchanged."

        self.git("commit", "--allow-empty", "-F", "-", input=original, check=True)

        self.assertEqual(self.commit_message(), original)

    def test_atrium_harness_claude_trailer_is_allowed(self) -> None:
        message = "feat: record harness\n\nAtrium-Harness: claude"

        result = self.git("commit", "--allow-empty", "-F", "-", input=message)

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_claude_coauthor_is_still_rejected(self) -> None:
        message = (
            "feat: forbidden attribution\n\n"
            "Co-authored-by: Claude <noreply@anthropic.com>"
        )

        result = self.git("commit", "--allow-empty", "-F", "-", input=message)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AI co-author attribution", result.stderr)

    def test_non_conventional_subject_is_still_rejected(self) -> None:
        result = self.git("commit", "--allow-empty", "-m", "not conventional")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conventional commit subject", result.stderr)


if __name__ == "__main__":
    unittest.main()
