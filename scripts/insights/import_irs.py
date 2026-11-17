"""Import free IRS nonprofit data into Cover's walled-off "insights" database section.

What it loads (all public government files, no donor or officer names):
  irs_bmf          IRS Exempt Organizations Business Master File: every US 501(c)(3) public charity
                   (churches and private foundations left out) with city, state, ZIP, cause code and
                   the latest revenue and assets the IRS has on file.
  irs_pub78        IRS Publication 78: which charities can receive tax-deductible gifts.
  irs_revocations  IRS auto-revocation list: 501(c)(3)s that lost their status.
  irs_990n         IRS 990-N postcards: the latest year each tiny charity filed.

It downloads each file, keeps only the columns Cover needs, and sends them in batches to the database
through secret-protected functions (see supabase/migrations/20261117000000_insights.sql). After a
good run it removes rows the new file no longer has; a run that loads too few rows never removes any.

Runs monthly on GitHub Actions (.github/workflows/insights-import.yml). Needs the environment
variable INSIGHTS_IMPORT_SECRET. The database address and public key are read from docs/js/config.js.

Run locally:
    python scripts/insights/import_irs.py --dry-run                 # download + count, upload nothing
    python scripts/insights/import_irs.py --sources irs_bmf         # one source
    python scripts/insights/import_irs.py --data-dir path/to/files  # use files you already downloaded
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONFIG_JS = REPO / "docs" / "js" / "config.js"

BMF_URLS = [f"https://www.irs.gov/pub/irs-soi/eo{n}.csv" for n in range(1, 5)]
EPOSTCARD = "https://apps.irs.gov/pub/epostcard/"
PUB78_URL = EPOSTCARD + "data-download-pub78.zip"
REVOCATIONS_URL = EPOSTCARD + "data-download-revocation.zip"
EPOSTCARD_URL = EPOSTCARD + "data-download-epostcard.zip"

SOURCES = ("irs_bmf", "irs_pub78", "irs_revocations", "irs_990n")
CHARITY_SUBSECTION = "03"                       # 501(c)(3)
CHURCH_FOUNDATION_CODE = "10"
PRIVATE_FOUNDATION_CODES = frozenset({"02", "03", "04"})
BATCH_SIZE = 1000                               # rows per database call (each call must finish in ~3 seconds)
PROGRESS_EVERY = 50_000                         # print a progress line this often
RETRIES = 4
TIMEOUT_SECONDS = 120
USER_AGENT = "Cover-insights-importer/1.0"
EIN_PATTERN = re.compile(r"^\d{9}$")
SECRET_MIN_LENGTH = 32


class ImportProblem(Exception):
    """Something went wrong that the person running the import should see."""


# ---------- Reading the IRS files (pure functions, tested on their own) ----------

def _int_or_none(text: str) -> int | None:
    text = (text or "").strip()
    return int(text) if text.lstrip("-").isdigit() else None


def bmf_row(record: dict[str, str]) -> list | None:
    """One registry line -> the row Cover keeps, or None if it isn't a 501(c)(3) public charity."""
    ein = (record.get("EIN") or "").strip()
    foundation = (record.get("FOUNDATION") or "").strip()
    if (
        not EIN_PATTERN.match(ein)
        or (record.get("SUBSECTION") or "").strip() != CHARITY_SUBSECTION
        or foundation == CHURCH_FOUNDATION_CODE
        or foundation in PRIVATE_FOUNDATION_CODES
    ):
        return None
    ruling = (record.get("RULING") or "").strip()
    return [
        ein,
        (record.get("NAME") or "").strip(),
        (record.get("CITY") or "").strip() or None,
        (record.get("STATE") or "").strip() or None,
        (record.get("ZIP") or "").strip()[:5] or None,
        (record.get("NTEE_CD") or "").strip() or None,
        foundation or None,
        int(ruling[:4]) if ruling[:4].isdigit() and ruling[:4] != "0000" else None,
        _int_or_none(record.get("REVENUE_AMT", "")),
        _int_or_none(record.get("ASSET_AMT", "")),
        _int_or_none(record.get("INCOME_AMT", "")),
        (record.get("TAX_PERIOD") or "").strip() or None,
    ]


def bmf_rows(lines: Iterable[str]) -> Iterator[list]:
    for record in csv.DictReader(lines):
        row = bmf_row(record)
        if row:
            yield row


def _pipe_fields(lines: Iterable[str]) -> Iterator[list[str]]:
    """Pipe-separated IRS lines, skipping blank ones (the files start with blank lines)."""
    for line in lines:
        line = line.strip("\r\n")
        if line.strip():
            yield line.split("|")


def pub78_rows(lines: Iterable[str], keep: set[str] | None = None) -> Iterator[list]:
    """Pub 78 lines -> [ein, deductibility codes]. `keep` limits it to EINs already in the registry."""
    for fields in _pipe_fields(lines):
        ein = fields[0].strip()
        if EIN_PATTERN.match(ein) and (keep is None or ein in keep):
            yield [ein, (fields[5].strip() if len(fields) > 5 else "") or None]


def irs_date(text: str) -> str | None:
    """"15-NOV-2017" -> "2017-11-15". Blank or odd values -> None."""
    try:
        return datetime.strptime(text.strip(), "%d-%b-%Y").date().isoformat()
    except ValueError:
        return None


def revocation_rows(lines: Iterable[str]) -> Iterator[list]:
    """Revocation lines -> [ein, revoked_on, reinstated_on] for 501(c)(3)s only."""
    for fields in _pipe_fields(lines):
        if len(fields) < 12 or not EIN_PATTERN.match(fields[0].strip()) or fields[8].strip() != CHARITY_SUBSECTION:
            continue
        yield [fields[0].strip(), irs_date(fields[9]), irs_date(fields[11])]


def latest_990n_years(lines: Iterable[str], keep: set[str] | None = None) -> list[list]:
    """990-N lines -> [ein, latest tax year]. Only the EIN and year are read (never names or addresses)."""
    latest: dict[str, int] = {}
    for fields in _pipe_fields(lines):
        ein = fields[0].strip()
        year = _int_or_none(fields[1]) if len(fields) > 1 else None
        if EIN_PATTERN.match(ein) and year and (keep is None or ein in keep):
            latest[ein] = max(year, latest.get(ein, 0))
    return [[ein, year] for ein, year in sorted(latest.items())]


def batches(rows: Iterable[list], size: int = BATCH_SIZE) -> Iterator[list[list]]:
    batch: list[list] = []
    for row in rows:
        batch.append(row)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def read_config(path: Path = CONFIG_JS) -> tuple[str, str]:
    """The database address and public key from the website's config.js."""
    text = path.read_text(encoding="utf-8")
    url = re.search(r'SUPABASE_URL\s*=\s*"(https://[^"]+)"', text)
    key = re.search(r'SUPABASE_PUBLISHABLE_KEY\s*=\s*"([^"]+)"', text)
    if not url or not key:
        raise ImportProblem(f"Couldn't find the database address and key in {path}.")
    return url.group(1), key.group(1)


# ---------- Getting the files ----------

@dataclass
class Download:
    data: bytes
    file_date: date


def fetch(url: str, data_dir: Path | None) -> Download:
    """Download a file (or read it from data_dir), with the date the IRS last changed it."""
    if data_dir:
        path = data_dir / url.rsplit("/", 1)[1]
        if not path.is_file():
            raise ImportProblem(f"Missing {path}. Download {url} there first, or run without --data-dir.")
        return Download(path.read_bytes(), date.fromtimestamp(path.stat().st_mtime))
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS * 5) as response:
                modified = response.headers.get("Last-Modified")
                file_date = parsedate_to_datetime(modified).date() if modified else date.today()
                return Download(response.read(), file_date)
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == RETRIES:
                raise ImportProblem(f"Couldn't download {url}: {error}") from error
            time.sleep(5 * attempt)
    raise ImportProblem(f"Couldn't download {url}.")


def zip_lines(data: bytes) -> Iterator[str]:
    """Text lines of the single file inside an IRS zip."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        name = archive.namelist()[0]
        with archive.open(name) as handle:
            yield from io.TextIOWrapper(handle, encoding="latin-1", newline="")


# ---------- Sending to the database ----------

class Database:
    """Calls the insights_import_* functions with the import secret."""

    def __init__(self, url: str, key: str, secret: str) -> None:
        self.base = f"{url}/rest/v1/rpc/"
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                        "User-Agent": USER_AGENT}
        self.secret = secret

    def call(self, name: str, **args) -> object:
        body = json.dumps({"secret": self.secret, **args}).encode("utf-8")
        for attempt in range(1, RETRIES + 1):
            request = urllib.request.Request(self.base + name, data=body, headers=self.headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                    text = response.read().decode("utf-8")
                    return json.loads(text) if text else None
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:300]
                if error.code < 500 or attempt == RETRIES:
                    raise ImportProblem(f"{name} failed ({error.code}): {detail}") from error
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt == RETRIES:
                    raise ImportProblem(f"{name} failed: {error}") from error
            time.sleep(3 * attempt)
        raise ImportProblem(f"{name} failed.")


def run_source(db: Database | None, source: str, function: str, rows: Iterable[list], file_date: date) -> int:
    """Load one source in batches, clean up old rows, and record the result. db=None counts only."""
    if db is None:
        total = sum(len(batch) for batch in batches(rows))
        print(f"{source}: {total:,} rows (dry run, nothing uploaded)")
        return total
    started = db.call("insights_import_start", source_name=source, file_day=file_date.isoformat())
    sent = 0
    next_report = PROGRESS_EVERY
    try:
        for batch in batches(rows):
            db.call(f"insights_import_{function}", batch=batch)
            sent += len(batch)
            if sent >= next_report:
                print(f"  {source}: {sent:,} rows sent")
                next_report += PROGRESS_EVERY
        removed = 0
        while (count := int(db.call("insights_import_cleanup", source_name=source, run_started=started) or 0)) > 0:
            removed += count
        note = f"{sent:,} rows sent; {removed:,} old rows removed"
        db.call("insights_import_finish", source_name=source, ok=True, run_note=note)
        print(f"{source}: done. {note}")
        return sent
    except ImportProblem as problem:
        db.call("insights_import_finish", source_name=source, ok=False, run_note=str(problem)[:300])
        raise


# ---------- Putting it together ----------

def collect_bmf(data_dir: Path | None) -> tuple[list[list], date]:
    rows: list[list] = []
    newest = date.min
    for url in BMF_URLS:
        download = fetch(url, data_dir)
        newest = max(newest, download.file_date)
        rows.extend(bmf_rows(io.StringIO(download.data.decode("latin-1"), newline="")))
    return rows, newest


def run(sources: list[str], data_dir: Path | None, db: Database | None) -> dict[str, int]:
    results: dict[str, int] = {}
    known: set[str] | None = None
    if "irs_bmf" in sources or {"irs_pub78", "irs_990n"} & set(sources):
        bmf, bmf_date = collect_bmf(data_dir)
        known = {row[0] for row in bmf}  # Pub 78 and 990-N only matter for charities in the registry
        if "irs_bmf" in sources:
            results["irs_bmf"] = run_source(db, "irs_bmf", "orgs", bmf, bmf_date)
    plans: list[tuple[str, str, str, Callable[[Iterable[str]], Iterable[list]]]] = [
        ("irs_pub78", "pub78", PUB78_URL, lambda lines: pub78_rows(lines, known)),
        ("irs_revocations", "revocations", REVOCATIONS_URL, revocation_rows),
        ("irs_990n", "990n", EPOSTCARD_URL, lambda lines: latest_990n_years(lines, known)),
    ]
    for source, function, url, reader in plans:
        if source in sources:
            download = fetch(url, data_dir)
            results[source] = run_source(db, source, function, reader(zip_lines(download.data)), download.file_date)
    return results


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import free IRS nonprofit data into Cover's insights section.")
    parser.add_argument("--sources", default=",".join(SOURCES), help=f"comma list of: {', '.join(SOURCES)}")
    parser.add_argument("--data-dir", type=Path, help="read already-downloaded files from this folder")
    parser.add_argument("--dry-run", action="store_true", help="download and count rows, upload nothing")
    args = parser.parse_args(argv)
    args.sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    unknown = sorted(set(args.sources) - set(SOURCES))
    if unknown or not args.sources:
        parser.error(f"unknown source(s): {', '.join(unknown) or '(none given)'}")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        db = None
        if not args.dry_run:
            secret = os.environ.get("INSIGHTS_IMPORT_SECRET", "")
            if len(secret) < SECRET_MIN_LENGTH:
                raise ImportProblem("Set INSIGHTS_IMPORT_SECRET (it's in GitHub > Settings > Secrets), or use --dry-run.")
            db = Database(*read_config(), secret)
        run(args.sources, args.data_dir, db)
    except ImportProblem as problem:
        print(f"Import stopped: {problem}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
