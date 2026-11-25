"""Tests for design/rebrand.py. Run: python -m unittest design/test_rebrand.py -v

Each test works on a throwaway copy of the real site files, never the repo itself.
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rebrand  # loaded after the path line above

FILES = sorted({swap.path for swap in rebrand.swaps_for(rebrand.PALETTES["terracotta"])})


def copy_site(target: Path) -> None:
    """Copy just the files the rebrand touches into `target`, keeping their folders."""
    for relative in FILES:
        (target / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(rebrand.REPO / relative, target / relative)


class RebrandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        copy_site(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def read(self, relative: str) -> str:
        return (self.root / relative).read_text(encoding="utf-8")

    def test_every_palette_applies_cleanly_and_leaves_no_green(self) -> None:
        for name, palette in rebrand.PALETTES.items():
            with self.subTest(palette=name):
                fresh = Path(tempfile.mkdtemp())
                copy_site(fresh)
                changed = rebrand.rebrand(fresh, palette)
                self.assertEqual(len(changed), len(FILES))
                self.assertEqual(rebrand.leftover_greens({p: p.read_text(encoding="utf-8") for p in changed}), [])
                self.assertIn(f"--green: {palette.accent};", (fresh / "docs/css/cover.css").read_text(encoding="utf-8"))
                shutil.rmtree(fresh)

    def test_brick_uses_white_text_on_buttons_everywhere(self) -> None:
        rebrand.rebrand(self.root, rebrand.PALETTES["brick"])
        self.assertIn("--on-green: #FFFFFF;", self.read("docs/css/cover.css"))
        self.assertIn("background:#C93A35;color:#FFFFFF;", self.read("supabase/templates/sign-in.html"))
        self.assertEqual(self.read("docs/css/cover.css").count("color: var(--on-green); display"), 2)

    def test_check_mode_changes_nothing(self) -> None:
        before = self.read("docs/css/cover.css")
        rebrand.main(["terracotta", "--root", str(self.root), "--check"])
        self.assertEqual(self.read("docs/css/cover.css"), before)

    def test_running_twice_stops_without_touching_files(self) -> None:
        rebrand.rebrand(self.root, rebrand.PALETTES["terracotta"])
        after_first = {f: self.read(f) for f in FILES}
        with self.assertRaises(rebrand.RebrandError):
            rebrand.rebrand(self.root, rebrand.PALETTES["brick"])
        self.assertEqual({f: self.read(f) for f in FILES}, after_first)

    def test_missing_file_is_reported_and_nothing_written(self) -> None:
        (self.root / "supabase/templates/sign-in.html").unlink()
        before = self.read("docs/css/cover.css")
        with self.assertRaises(rebrand.RebrandError) as caught:
            rebrand.rebrand(self.root, rebrand.PALETTES["terracotta"])
        self.assertIn("missing file: supabase/templates/sign-in.html", str(caught.exception))
        self.assertEqual(self.read("docs/css/cover.css"), before)

    def test_empty_folder_gives_a_clear_error_not_a_crash(self) -> None:
        empty = Path(tempfile.mkdtemp())
        exit_code = rebrand.main(["terracotta", "--root", str(empty)])
        self.assertEqual(exit_code, 1)
        shutil.rmtree(empty)

    def test_palette_shades_are_readable(self) -> None:
        # Same contrast math as docs/js/brand.js: text on white needs 4.5, button text at least 3.5.
        def luminance(hex_color: str) -> float:
            values = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            linear = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]

        def contrast(a: str, b: str) -> float:
            high, low = sorted([luminance(a), luminance(b)], reverse=True)
            return (high + 0.05) / (low + 0.05)

        for name, p in rebrand.PALETTES.items():
            with self.subTest(palette=name):
                self.assertGreaterEqual(contrast(p.accent_dark, "#FFFFFF"), 4.5)
                self.assertGreaterEqual(contrast(p.accent, p.on_accent), 4.5)
                self.assertGreaterEqual(contrast("#FFFFFF", p.deep), 12)


if __name__ == "__main__":
    unittest.main()
