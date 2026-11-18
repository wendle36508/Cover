"""Tests for form990.py on real filings (trimmed, in fixtures/). Run: python -m unittest discover scripts/insights -v

Expected numbers were read off the original IRS e-files and cross-checked: Heading Home's year ending
June 30, 2023 shows total revenue $30,905,951, the same figure ProPublica lists for it.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import form990  # loaded after the path line above

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load(name: str) -> form990.FundingMix:
    mix = form990.read_funding_mix((FIXTURES / name).read_bytes())
    assert mix is not None
    return mix


class RealFilingTests(unittest.TestCase):
    def test_heading_home_year_ending_june_2023(self):
        mix = load("heading-home-ty2022.xml")
        self.assertEqual((mix.ein, mix.tax_year, mix.period_end), ("237364546", 2022, "2023-06-30"))
        self.assertEqual(mix.amounts["total_revenue"], 30_905_951)
        self.assertEqual(mix.amounts["government_grants"], 25_685_286)
        self.assertEqual(mix.amounts["other_contributions"], 1_946_578)
        self.assertEqual(mix.amounts["program_revenue"], 215_251)
        self.assertTrue(mix.contributions_add_up)
        self.assertAlmostEqual(mix.government_share, 0.8311, places=4)
        self.assertAlmostEqual(mix.individuals_share, (52_440 + 2_290_943 + 1_946_578) / 30_905_951)

    def test_heading_home_next_year(self):
        mix = load("heading-home-ty2023.xml")
        self.assertEqual((mix.tax_year, mix.period_end), (2023, "2024-06-30"))
        self.assertEqual(mix.amounts["total_revenue"], 42_822_916)
        self.assertEqual(mix.amounts["total_contributions"], 41_776_276)
        self.assertTrue(mix.contributions_add_up)

    def test_eccf_blank_program_revenue_counts_as_zero(self):
        mix = load("eccf-ty2024.xml")
        self.assertEqual((mix.ein, mix.tax_year), ("043407816", 2024))
        self.assertEqual(mix.amounts["total_revenue"], 24_689_727)
        self.assertEqual(mix.amounts["program_revenue"], 0)
        self.assertEqual(mix.amounts["government_grants"], 281_380)
        self.assertTrue(mix.contributions_add_up)
        self.assertGreater(mix.individuals_share, 0.75)


SNIPPET = """<Return xmlns="http://www.irs.gov/efile"><ReturnHeader><ReturnType>{form}</ReturnType><TaxYear>2012</TaxYear>
<Filer><EIN>123456789</EIN></Filer></ReturnHeader><ReturnData><IRS990>{body}</IRS990></ReturnData></Return>"""


def snippet(body: str, form: str = "990") -> bytes:
    return SNIPPET.format(body=body, form=form).encode()


class EdgeCaseTests(unittest.TestCase):
    def test_older_tag_names_from_before_2013_are_read(self):
        mix = form990.read_funding_mix(snippet(
            "<TotalRevenueCurrentYear>1000</TotalRevenueCurrentYear><GovernmentGrants>400</GovernmentGrants>"
            "<AllOtherContributions>500</AllOtherContributions><TotalContributions>900</TotalContributions>"))
        self.assertEqual(mix.amounts["total_revenue"], 1000)
        self.assertEqual(mix.government_share, 0.4)
        self.assertTrue(mix.contributions_add_up)

    def test_other_forms_are_skipped(self):
        for form in ("990EZ", "990PF"):
            self.assertIsNone(form990.read_funding_mix(snippet("<CYTotalRevenueAmt>1</CYTotalRevenueAmt>", form)))

    def test_zero_or_negative_revenue_gives_no_share(self):
        mix = form990.read_funding_mix(snippet("<CYTotalRevenueAmt>0</CYTotalRevenueAmt>"))
        self.assertIsNone(mix.individuals_share)
        mix = form990.read_funding_mix(snippet("<CYTotalRevenueAmt>-50</CYTotalRevenueAmt>"))
        self.assertIsNone(mix.government_share)

    def test_lines_that_dont_add_up_are_flagged(self):
        mix = form990.read_funding_mix(snippet(
            "<CYTotalRevenueAmt>100</CYTotalRevenueAmt><GovernmentGrantsAmt>10</GovernmentGrantsAmt><TotalContributionsAmt>99</TotalContributionsAmt>"))
        self.assertFalse(mix.contributions_add_up)

    def test_bad_files_give_clear_errors(self):
        for bad in (b"not xml", b"", snippet("<GovernmentGrantsAmt>5</GovernmentGrantsAmt>"),
                    snippet("<CYTotalRevenueAmt>12.5</CYTotalRevenueAmt>")):
            with self.assertRaises(form990.Form990Problem):
                form990.read_funding_mix(bad)

    def test_every_field_has_a_line_and_tag_names(self):
        for name, (line, tags) in form990.FIELD_MAP.items():
            self.assertTrue(line and tags, name)
            self.assertTrue(all(tag[0].isupper() for tag in tags), name)


if __name__ == "__main__":
    unittest.main()
