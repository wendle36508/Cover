"""Tests for import_irs.py. Run: python -m unittest discover scripts/insights -v

The parsing tests use tiny made-up lines in the IRS formats. The upload test uses a fake database
so nothing leaves the computer.
"""

import io
import sys
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_irs as irs  # loaded after the path line above

BMF_HEADER = ("EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,"
              "FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,"
              "ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME")


def bmf_line(ein="012345678", subsection="03", foundation="15", revenue="250000", ruling="200105", ico="JANE DOE"):
    return (f'{ein},HARBOR PAWS RESCUE,{ico},12 MAIN ST,PORTLAND,ME,04101-1234,0000,{subsection},3,1000,{ruling},1,'
            f'{foundation},000000000,1,01,202406,4,4,01,0,06,90000,300000,{revenue},D20,')


class ParsingTests(unittest.TestCase):
    def test_public_charity_is_kept_with_only_the_needed_columns(self):
        rows = list(irs.bmf_rows(io.StringIO(f"{BMF_HEADER}\n{bmf_line()}\n")))
        self.assertEqual(rows, [["012345678", "HARBOR PAWS RESCUE", "PORTLAND", "ME", "04101", "D20", "15", 2001,
                                 250000, 90000, 300000, "202406"]])

    def test_no_person_or_street_data_is_kept(self):
        row = irs.bmf_row(dict(zip(BMF_HEADER.split(","), bmf_line(ico="JANE DOE").split(","))))
        self.assertNotIn("JANE DOE", row)
        self.assertNotIn("12 MAIN ST", row)

    def test_churches_private_foundations_and_non_charities_are_left_out(self):
        lines = [bmf_line(foundation="10"), bmf_line(foundation="04"), bmf_line(subsection="04"), bmf_line(ein="12")]
        self.assertEqual(list(irs.bmf_rows(io.StringIO("\n".join([BMF_HEADER, *lines])))), [])

    def test_blank_amounts_and_ruling_become_none(self):
        row = irs.bmf_row(dict(zip(BMF_HEADER.split(","), bmf_line(revenue="", ruling="000000").split(","))))
        self.assertIsNone(row[8])
        self.assertIsNone(row[7])

    def test_pub78_skips_blank_lines_and_can_filter_to_known_charities(self):
        text = "\n\n\n012345678|Harbor Paws|Portland|ME|United States|PC\n999999999|Other|X|CA|United States|PF\n"
        self.assertEqual(list(irs.pub78_rows(io.StringIO(text))), [["012345678", "PC"], ["999999999", "PF"]])
        self.assertEqual(list(irs.pub78_rows(io.StringIO(text), keep={"012345678"})), [["012345678", "PC"]])

    def test_revocations_keep_charities_and_read_irs_dates(self):
        text = ("\n012345678|NAME ||1 ST|CITY|ME|04101|US|03|15-NOV-2017|12-MAR-2018|01-FEB-2020\n"
                "111111111|NAME ||1 ST|CITY|ME|04101|US|04|15-NOV-2017|12-MAR-2018|\n"
                "222222222|SHORT|LINE\n")
        self.assertEqual(list(irs.revocation_rows(io.StringIO(text))), [["012345678", "2017-11-15", "2020-02-01"]])
        self.assertIsNone(irs.irs_date(""))
        self.assertIsNone(irs.irs_date("31-FOO-2020"))

    def test_990n_keeps_latest_year_and_never_names(self):
        text = ("012345678|2022|SMALL RESCUE|F|T|01-01-2022|12-31-2022||Pat Officer|9 Home Rd||Town||ME|04101|US\n"
                "012345678|2025|SMALL RESCUE|F|T|01-01-2025|12-31-2025||Pat Officer|9 Home Rd||Town||ME|04101|US\n"
                "333333333|bad|X\n")
        rows = irs.latest_990n_years(io.StringIO(text))
        self.assertEqual(rows, [["012345678", 2025]])
        self.assertNotIn("Pat Officer", str(rows))
        self.assertEqual(irs.latest_990n_years(io.StringIO(text), keep=set()), [])

    def test_batches_split_evenly_and_handle_empty(self):
        self.assertEqual([len(b) for b in irs.batches(([i] for i in range(2500)), size=1000)], [1000, 1000, 500])
        self.assertEqual(list(irs.batches([])), [])

    def test_config_is_read_from_the_site(self):
        url, key = irs.read_config()
        self.assertTrue(url.startswith("https://") and key.startswith("sb_publishable_"))
        with tempfile.TemporaryDirectory() as folder:
            broken = Path(folder) / "config.js"
            broken.write_text("export const NOTHING = 1;")
            with self.assertRaises(irs.ImportProblem):
                irs.read_config(broken)


class FakeDatabase:
    """Records calls instead of sending them. cleanup returns `removable` rows once, then 0."""

    def __init__(self, removable=0, fail_on=None):
        self.calls = []
        self.removable = removable
        self.fail_on = fail_on

    def call(self, name, **args):
        self.calls.append((name, args))
        if name == self.fail_on:
            raise irs.ImportProblem("boom")
        if name == "insights_import_start":
            return "2026-11-17T00:00:00Z"
        if name == "insights_import_cleanup":
            removed, self.removable = self.removable, 0
            return removed
        return None


class UploadTests(unittest.TestCase):
    def test_a_good_run_starts_sends_batches_cleans_up_and_finishes(self):
        db = FakeDatabase(removable=7)
        sent = irs.run_source(db, "irs_bmf", "orgs", ([str(i)] for i in range(2001)), date(2026, 11, 10))
        self.assertEqual(sent, 2001)
        names = [name for name, _ in db.calls]
        self.assertEqual(names[0], "insights_import_start")
        self.assertEqual(names.count("insights_import_orgs"), 3)
        self.assertEqual(names.count("insights_import_cleanup"), 2)
        self.assertEqual(db.calls[-1], ("insights_import_finish", {"source_name": "irs_bmf", "ok": True,
                                                                   "run_note": "2,001 rows sent; 7 old rows removed"}))

    def test_a_failed_upload_is_recorded_and_reported(self):
        db = FakeDatabase(fail_on="insights_import_orgs")
        with self.assertRaises(irs.ImportProblem):
            irs.run_source(db, "irs_bmf", "orgs", [["1"]], date(2026, 11, 10))
        self.assertEqual(db.calls[-1][0], "insights_import_finish")
        self.assertFalse(db.calls[-1][1]["ok"])

    def test_dry_run_counts_without_a_database(self):
        self.assertEqual(irs.run_source(None, "irs_990n", "990n", [["1"], ["2"]], date(2026, 11, 10)), 2)

    def test_whole_run_from_local_files(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            (folder / "eo1.csv").write_text(f"{BMF_HEADER}\n{bmf_line()}\n{bmf_line(ein='999999999', foundation='10')}\n")
            for name in ("eo2.csv", "eo3.csv", "eo4.csv"):
                (folder / name).write_text(f"{BMF_HEADER}\n")
            for name, line in (("data-download-pub78", "012345678|Harbor Paws|Portland|ME|US|PC"),
                               ("data-download-revocation", "555555555|X||1 ST|C|ME|0|US|03|01-JAN-2020|02-JAN-2020|"),
                               ("data-download-epostcard", "012345678|2025|X|F|T")):
                with zipfile.ZipFile(folder / f"{name}.zip", "w") as archive:
                    archive.writestr(f"{name}.txt", f"\n{line}\n")
            db = FakeDatabase()
            results = irs.run(list(irs.SOURCES), folder, db)
        self.assertEqual(results, {"irs_bmf": 1, "irs_pub78": 1, "irs_revocations": 1, "irs_990n": 1})

    def test_bad_arguments_and_missing_secret_give_clear_errors(self):
        with self.assertRaises(SystemExit):
            irs.parse_args(["--sources", "irs_bmf,nope"])
        saved = irs.os.environ.pop("INSIGHTS_IMPORT_SECRET", None)
        try:
            self.assertEqual(irs.main(["--sources", "irs_bmf"]), 1)
        finally:
            if saved is not None:
                irs.os.environ["INSIGHTS_IMPORT_SECRET"] = saved

    def test_missing_local_file_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(irs.ImportProblem):
            irs.fetch(irs.PUB78_URL, Path(folder))


if __name__ == "__main__":
    unittest.main()
