"""
shoot.py - takes desktop and phone screenshots of the design mockups with headless Microsoft Edge,
so each direction can be compared side by side as images.

Usage:
    python design/shoot.py                 # every mockup in design/mockups
    python design/shoot.py a-board         # just one
Output: design/shots/<name>-desktop.png, <name>-phone.png and <name>-compare.png
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops

DESIGN_DIR = Path(__file__).resolve().parent
MOCKUP_DIR = DESIGN_DIR / "mockups"
SHOT_DIR = DESIGN_DIR / "shots"
EDGE_PATHS = [
    Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
    Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
]
SIZES = {"desktop": (1440, 7000), "phone": (390, 9000)}  # tall windows, then empty space is trimmed
WAIT_MS = 4000  # time for web fonts and scripts to load before the shot
MIN_WINDOW_PX = 520  # narrower than this, the page is shot inside a frame
PATTERN_PX = 14  # repeat size of the dotted background in the round-one board mockup
ATTEMPTS = 2  # Edge sometimes hangs on a big page; try once more
TIMEOUT_S = 90
# Pages that are templates get one shot per version, e.g. donor.html?org=pantry.
VARIANTS = {
    "donor": [(org, f"org={org}") for org in ("rescue", "pantry", "youth")],
    "dashboard": [(view, f"view={view}") for view in ("overview", "items")],
}
# Pages shot first, because other pages show their screenshots (the company site shows the donor page).
SHOOT_FIRST = ["donor"]
PHONE_PEEK_PX = 1700  # how much of the phone page goes on the comparison sheet


def find_edge() -> Path:
    for path in EDGE_PATHS:
        if path.is_file():
            return path
    raise FileNotFoundError("Microsoft Edge wasn't found. It's needed to take the screenshots.")


def shot_list(pages: list[Path]) -> list[tuple[str, str]]:
    """(name, url) for every screenshot to take, template versions included."""
    pages = sorted(pages, key=lambda page: (page.stem not in SHOOT_FIRST, page.stem))
    shots = []
    for page in pages:
        versions = VARIANTS.get(page.stem)
        if versions:
            shots += [(f"{page.stem}-{name}", f"{page.as_uri()}?{query}") for name, query in versions]
        else:
            shots.append((page.stem, page.as_uri()))
    return shots


def phone_frame(name: str, url: str, size: tuple[int, int]) -> Path:
    """A throwaway page holding the mockup in a phone-width frame.

    Edge's headless window can't get as narrow as a phone, but a frame can.
    """
    frame = SHOT_DIR / f"_{name}-frame.html"
    frame.write_text(
        f'<body style="margin:0"><iframe src="{url}" '
        f'style="width:{size[0]}px;height:{size[1]}px;border:0;display:block"></iframe></body>',
        encoding="utf-8",
    )
    return frame


def shoot(edge: Path, name: str, url: str, label: str, size: tuple[int, int]) -> Path:
    out = SHOT_DIR / f"{name}-{label}.png"
    frame = None
    target = url
    window = size
    if size[0] < MIN_WINDOW_PX:
        frame = phone_frame(name, url, size)
        target = frame.as_uri()
        window = (MIN_WINDOW_PX, size[1])
    command = [
        str(edge), "--headless=new", "--disable-gpu", "--hide-scrollbars",
        f"--window-size={window[0]},{window[1]}", f"--virtual-time-budget={WAIT_MS}",
        f"--screenshot={out}", target,
    ]
    for attempt in range(1, ATTEMPTS + 1):
        try:
            subprocess.run(command, check=True, capture_output=True, timeout=TIMEOUT_S)
            break
        except subprocess.TimeoutExpired:
            if attempt == ATTEMPTS:
                raise RuntimeError(f"Edge kept hanging on {name} ({label}).") from None
    if frame:
        frame.unlink()
        Image.open(out).crop((0, 0, size[0], size[1])).save(out)
    trim_bottom(out)
    return out


def trim_bottom(path: Path, margin: int = 60) -> None:
    """Cut off the empty page below the content (the window is taller than the page).

    A row counts as empty when it matches the bottom of the page at the same point in the
    background pattern, so a dotted or textured background is handled too.
    """
    image = Image.open(path).convert("RGB")
    height = image.height
    block_top = height - 2 * PATTERN_PX
    last_content = 0
    for y in range(block_top - 1, -1, -1):
        reference = block_top + (y - block_top) % PATTERN_PX
        row = image.crop((0, y, image.width, y + 1))
        ref_row = image.crop((0, reference, image.width, reference + 1))
        if max(high for _, high in ImageChops.difference(row, ref_row).getextrema()) > 10:
            last_content = y
            break
    if last_content:
        image.crop((0, 0, image.width, min(height, last_content + margin))).save(path)


def compare_sheet(name: str) -> Path:
    """Desktop view and the first two phone screens side by side, for picking a direction."""
    desktop = Image.open(SHOT_DIR / f"{name}-desktop.png").convert("RGB")
    phone = Image.open(SHOT_DIR / f"{name}-phone.png").convert("RGB")
    desktop = desktop.resize((900, round(desktop.height * 900 / desktop.width)), Image.LANCZOS)
    phone = phone.crop((0, 0, phone.width, min(phone.height, PHONE_PEEK_PX)))
    sheet = Image.new("RGB", (900 + phone.width + 120, max(desktop.height, phone.height) + 80), "#FFFFFF")
    sheet.paste(desktop, (40, 40))
    sheet.paste(phone, (900 + 80, 40))
    out = SHOT_DIR / f"{name}-compare.png"
    sheet.save(out)
    return out


def main(names: list[str]) -> int:
    try:
        edge = find_edge()
    except FileNotFoundError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    pages = sorted(MOCKUP_DIR.glob("*.html"))
    if names:
        pages = [page for page in pages if page.stem in names]
    if not pages:
        print("Error: no matching mockups found in design/mockups.", file=sys.stderr)
        return 1
    SHOT_DIR.mkdir(exist_ok=True)
    try:
        for name, url in shot_list(pages):
            for label, size in SIZES.items():
                print(f"Saved {shoot(edge, name, url, label, size)}")
            print(f"Saved {compare_sheet(name)}")
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
