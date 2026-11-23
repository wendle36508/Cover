"""Switch Cover's brand color in one go (green -> a red palette), ready for the rebrand.

Almost every color on the site comes from five settings at the top of docs/css/cover.css.
This script rewrites those, plus the handful of places that have the green typed in
directly (the Stripe payout boxes, the dashboard color picker, the sponsor emails and
the sign-in email). It works on the files as they are today (green) and stops with a
clear message if something it expects to find has moved, so nothing is half-changed.

It does NOT touch the logo files; those get swapped separately once the new logo is
drawn as clean outlines (see company/brain/Runbooks.md, "Rebrand to red").

Run a preview on a copy first:  python design/rebrand.py terracotta --root <copy-folder>
Then for real (from the repo):   python design/rebrand.py terracotta
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Today's green palette, exactly as it's typed in the files.
OLD_ACCENT = "#22C67A"
OLD_ACCENT_DARK = "#0B6B47"
OLD_TINT = "#EAF8F0"
OLD_DEEP = "#0C2B24"
OLD_ON_ACCENT = "#14181C"


@dataclass(frozen=True)
class Palette:
    """One brand palette. Shades come from docs/js/brand.js so they pass contrast checks."""

    label: str
    accent: str  # buttons, bars, checks, the logo underline and heart
    accent_dark: str  # links and colored text on white
    tint: str  # pale backgrounds (hero fade, chips)
    deep: str  # dark sections
    on_accent: str  # text on top of the accent color


PALETTES = {
    # Tanner's original pick: the handwritten logo's terracotta (#D9653B). Dark text on buttons.
    "terracotta": Palette("Terracotta", "#D9653B", "#B85632", "#FAEDE7", "#2B1A15", "#14181C"),
    # A truer brick red, if terracotta reads too orange. White text on buttons.
    "brick": Palette("Brick red", "#C93A35", "#C93A35", "#F9E7E7", "#2A1513", "#FFFFFF"),
}


@dataclass(frozen=True)
class Swap:
    """Replace one exact piece of text in one file. `count` = how many times it must appear."""

    path: str
    old: str
    new: str
    count: int = 1


class RebrandError(Exception):
    """Something the script expected to find isn't there (the file changed since it was written)."""


def swaps_for(palette: Palette) -> list[Swap]:
    """Every text change needed to move the site from green to `palette`."""
    p = palette
    css = "docs/css/cover.css"
    email = "supabase/functions/_shared/email.js"
    return [
        # The five color settings everything else reads from.
        Swap(css, f"--mint: {OLD_TINT};", f"--mint: {p.tint};"),
        Swap(css, f"--green: {OLD_ACCENT};", f"--green: {p.accent};"),
        Swap(css, f"--green-dark: {OLD_ACCENT_DARK};", f"--green-dark: {p.accent_dark};"),
        Swap(css, f"--deep: {OLD_DEEP};", f"--deep: {p.deep};"),
        Swap(css, f"--on-green: {OLD_ON_ACCENT};", f"--on-green: {p.on_accent};"),
        Swap(css, "bright green accent.", f"{p.label.lower()} accent (names still say green)."),
        # Check marks and the "thank you" stamp sit on the accent, so their icon color must flip too.
        Swap(css, "background: var(--green); color: var(--ink); display: inline-grid;",
             "background: var(--green); color: var(--on-green); display: inline-grid;"),
        Swap(css, "background: var(--green); color: var(--ink); display: grid;",
             "background: var(--green); color: var(--on-green); display: grid;"),
        # Stripe's payout boxes and the dashboard color picker.
        Swap("docs/js/dashboard.js", f'colorPrimary: "{OLD_ACCENT_DARK}"', f'colorPrimary: "{p.accent_dark}"'),
        Swap("docs/js/dashboard.js", f'?? "{OLD_ACCENT}"', f'?? "{p.accent}"'),
        Swap("docs/dashboard.html", f'placeholder="{OLD_ACCENT}"', f'placeholder="{p.accent}"'),
        Swap("docs/js/brand.js", f'BRAND_SWATCHES = ["{OLD_ACCENT}"', f'BRAND_SWATCHES = ["{p.accent}"'),
        # Sponsor emails (adoption note, owner updates and the My gifts link email).
        Swap(email, f"color:{OLD_ACCENT_DARK};margin:0 0 12px", f"color:{p.accent_dark};margin:0 0 12px", count=4),
        Swap(email, f"background:{OLD_ACCENT};color:{OLD_ON_ACCENT};", f"background:{p.accent};color:{p.on_accent};", count=3),
        Swap(email, f'style="color:{OLD_ACCENT_DARK};font-weight:700">', f'style="color:{p.accent_dark};font-weight:700">'),
        # Sign-in email (has to be re-pasted into Supabase after this runs).
        Swap("supabase/templates/sign-in.html", f'<span style="color:{OLD_ACCENT}">', f'<span style="color:{p.accent}">'),
        Swap("supabase/templates/sign-in.html", f"background:{OLD_ACCENT};color:{OLD_ON_ACCENT};",
             f"background:{p.accent};color:{p.on_accent};"),
    ]


def plan_changes(root: Path, swaps: list[Swap]) -> dict[Path, str]:
    """Work out the new text of every file, without writing anything. Raises if anything is off."""
    new_text: dict[Path, str] = {}
    problems: list[str] = []
    for swap in swaps:
        path = root / swap.path
        if path not in new_text:
            if not path.is_file():
                problems.append(f"missing file: {swap.path}")
                continue
            new_text[path] = path.read_text(encoding="utf-8")
        found = new_text[path].count(swap.old)
        if found != swap.count:
            problems.append(f"{swap.path}: expected {swap.count}x {swap.old!r}, found {found}")
            continue
        new_text[path] = new_text[path].replace(swap.old, swap.new)
    if problems:
        raise RebrandError("Nothing was changed. Fix these first:\n  " + "\n  ".join(problems))
    return new_text


def leftover_greens(texts: dict[Path, str]) -> list[str]:
    """Any old green hex codes still left in the changed files (should be none)."""
    pattern = re.compile("|".join(re.escape(c) for c in (OLD_ACCENT, OLD_ACCENT_DARK, OLD_TINT, OLD_DEEP)), re.IGNORECASE)
    return [f"{path.name}: {match}" for path, text in texts.items() for match in pattern.findall(text)]


def rebrand(root: Path, palette: Palette, write: bool = True) -> list[Path]:
    """Apply the palette under `root`. All-or-nothing: checks every change before writing any."""
    texts = plan_changes(root, swaps_for(palette))
    leftovers = leftover_greens(texts)
    if leftovers:
        raise RebrandError("Old green still left after the swap:\n  " + "\n  ".join(leftovers))
    if write:
        for path, text in texts.items():
            path.write_text(text, encoding="utf-8")
    return sorted(texts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Switch Cover's brand color from green to a red palette.")
    parser.add_argument("palette", choices=sorted(PALETTES), help="which red to use")
    parser.add_argument("--root", type=Path, default=REPO, help="folder to change (default: this repo)")
    parser.add_argument("--check", action="store_true", help="only check that it would work; change nothing")
    args = parser.parse_args(argv)
    try:
        changed = rebrand(args.root, PALETTES[args.palette], write=not args.check)
    except RebrandError as problem:
        print(problem, file=sys.stderr)
        return 1
    verb = "Would change" if args.check else "Changed"
    print(f"{verb} {len(changed)} files to {PALETTES[args.palette].label}:")
    for path in changed:
        print(f"  {path.relative_to(args.root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
