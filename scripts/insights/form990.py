"""Read a nonprofit's funding mix from one IRS Form 990 e-file (XML).

The field map below was checked on Nov 18, 2026 against the Nonprofit Open Data Collective's
Master Concordance File (github.com/Nonprofit-Open-Data-Collective/irs-efile-master-concordance-file,
concordance.csv) and against real filings for Heading Home (EIN 23-7364546) and Essex County
Community Foundation (EIN 04-3407816). The IRS renamed many tags around 2013 (for example
GovernmentGrants -> GovernmentGrantsAmt), so each field lists every name the concordance gives.

Only the full Form 990 is read (not 990-EZ, 990-N or 990-PF): Part VIII's revenue lines exist only there.
Watch the year: TaxYr is the year the fiscal year STARTED. Heading Home's year ending June 30, 2023
is TaxYr 2022 in the file, even though some sites call it "FY2023".

Used by the insights work (funding-mix card, peer benchmarks). Not wired into the monthly import yet.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass

IRS_NAMESPACE = "{http://www.irs.gov/efile}"

# Our name -> (form line, every IRS tag name for it, newest first), per the concordance.
FIELD_MAP: dict[str, tuple[str, tuple[str, ...]]] = {
    "total_revenue": ("Part I line 12 (current year)", ("CYTotalRevenueAmt", "TotalRevenueCurrentYear")),
    "federated_campaigns": ("Part VIII line 1a", ("FederatedCampaignsAmt", "FederatedCampaigns")),
    "membership_dues": ("Part VIII line 1b", ("MembershipDuesAmt", "MembershipDues")),
    "fundraising_events": ("Part VIII line 1c", ("FundraisingAmt", "FundraisingEvents")),
    "related_organizations": ("Part VIII line 1d", ("RelatedOrganizationsAmt", "RelatedOrganizations")),
    "government_grants": ("Part VIII line 1e", ("GovernmentGrantsAmt", "GovernmentGrants")),
    "other_contributions": ("Part VIII line 1f", ("AllOtherContributionsAmt", "AllOtherContributions")),
    "total_contributions": ("Part VIII line 1h", ("TotalContributionsAmt", "TotalContributions")),
    "program_revenue": ("Part VIII line 2g", ("TotalProgramServiceRevenueAmt", "TotalProgramServiceRevenue")),
}
CONTRIBUTION_LINES = ("federated_campaigns", "membership_dues", "fundraising_events", "related_organizations",
                      "government_grants", "other_contributions")
# "Money from individuals" per the research report: 1f plus 1a and 1c (1b dues, 1d related orgs and
# 1e government grants are left out).
INDIVIDUAL_LINES = ("other_contributions", "federated_campaigns", "fundraising_events")
FULL_FORM_990 = "990"


class Form990Problem(Exception):
    """The file couldn't be read as an IRS 990 e-file."""


@dataclass(frozen=True)
class FundingMix:
    ein: str
    tax_year: int
    period_end: str
    amounts: dict[str, int]

    @property
    def contributions_add_up(self) -> bool:
        """Lines 1a-1f should equal line 1h. False means the filing (or our map) is off."""
        return sum(self.amounts[line] for line in CONTRIBUTION_LINES) == self.amounts["total_contributions"]

    def share(self, lines: tuple[str, ...]) -> float | None:
        """Fraction of total revenue from these lines; None when total revenue is zero or negative."""
        total = self.amounts["total_revenue"]
        return sum(self.amounts[line] for line in lines) / total if total > 0 else None

    @property
    def individuals_share(self) -> float | None:
        return self.share(INDIVIDUAL_LINES)

    @property
    def government_share(self) -> float | None:
        return self.share(("government_grants",))


def _text(root: ET.Element, *tags: str) -> str | None:
    for tag in tags:
        element = root.find(f".//{IRS_NAMESPACE}{tag}")
        if element is not None and element.text and element.text.strip():
            return element.text.strip()
    return None


def _amount(root: ET.Element, tags: tuple[str, ...]) -> int:
    """A dollar amount; a line the filer left blank counts as 0."""
    text = _text(root, *tags)
    if text is None:
        return 0
    try:
        return int(text)
    except ValueError as error:
        raise Form990Problem(f"Not a whole-dollar amount in {tags[0]}: {text!r}") from error


def read_funding_mix(xml_bytes: bytes) -> FundingMix | None:
    """The funding mix from one e-file, or None if it isn't a full Form 990."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as error:
        raise Form990Problem(f"Not valid XML: {error}") from error
    if _text(root, "ReturnTypeCd", "ReturnType") != FULL_FORM_990:
        return None
    ein = _text(root, "EIN")
    year = _text(root, "TaxYr", "TaxYear")
    period_end = _text(root, "TaxPeriodEndDt", "TaxPeriodEndDate")
    if not ein or not year or not year.isdigit() or _text(root, *FIELD_MAP["total_revenue"][1]) is None:
        raise Form990Problem("Missing the EIN, tax year or total revenue.")
    amounts = {name: _amount(root, tags) for name, (_, tags) in FIELD_MAP.items()}
    return FundingMix(ein=ein, tax_year=int(year), period_end=period_end or "", amounts=amounts)
