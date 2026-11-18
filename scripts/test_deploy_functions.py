"""Tests for deploy_functions.py. Run: python -m unittest discover scripts -p "test_deploy*.py" -v"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_functions as deploy  # loaded after the path line above


class DeployTests(unittest.TestCase):
    def test_finds_real_functions_and_skips_shared_code(self):
        found = deploy.all_functions()
        self.assertIn("create-sponsorship", found)
        self.assertNotIn("_shared", found)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a").mkdir()
            (root / "a" / "index.ts").write_text("")
            (root / "_shared").mkdir()
            (root / "empty").mkdir()
            self.assertEqual(deploy.all_functions(root), ["a"])

    def test_picking_functions(self):
        self.assertEqual(deploy.pick_functions([], ["a", "b"]), ["a", "b"])
        self.assertEqual(deploy.pick_functions(["b", "b"], ["a", "b"]), ["b"])
        with self.assertRaises(deploy.DeployProblem):
            deploy.pick_functions(["nope"], ["a", "b"])

    def test_a_failed_check_stops_before_any_deploy(self):
        calls = []

        def fake_run(command, **_):
            calls.append(command)
            return mock.Mock(returncode=1, stdout="1 test failed", stderr="")

        with mock.patch.object(deploy.subprocess, "run", fake_run), mock.patch.object(deploy, "tool", lambda name: name):
            self.assertEqual(deploy.main(["sponsor-email"]), 1)
        self.assertEqual(len(calls), 1, "stopped at the first failed check")
        self.assertFalse(any("deploy" in part for command in calls for part in command))

    def test_check_only_never_deploys(self):
        calls = []

        def fake_run(command, **_):
            calls.append(command)
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch.object(deploy.subprocess, "run", fake_run), mock.patch.object(deploy, "tool", lambda name: name):
            self.assertEqual(deploy.main(["--check-only"]), 0)
        self.assertEqual(len(calls), 3)
        self.assertFalse(any(part == "deploy" for command in calls for part in command))

    def test_missing_tool_is_a_clear_error(self):
        with mock.patch.object(deploy.shutil, "which", return_value=None), self.assertRaises(deploy.DeployProblem):
            deploy.tool("npx")


if __name__ == "__main__":
    unittest.main()
