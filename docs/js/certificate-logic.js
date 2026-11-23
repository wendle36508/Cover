// certificate-logic.js - the words on a sponsor's photo certificate (certificate.html). Plain code, so
// Node can test it. The server sends only what's safe to show: a name, who or what they sponsor, the
// nonprofit, and the month they started. Never an email address or an amount.

/**
 * view: { holder, giftFrom, itemName, orgName, since, once }
 * Returns { title, intro, holder, line, date, gift } - every piece is plain text.
 */
export function certificateWords(view) {
  const wholeOrg = !view.itemName || view.itemName === view.orgName;
  const what = wholeOrg ? view.orgName : `${view.itemName} at ${view.orgName}`;
  return {
    title: view.once ? "Certificate of Thanks" : "Certificate of Sponsorship",
    intro: "This certifies that",
    holder: view.holder,
    line: view.once ? `made a gift for ${what}` : `sponsors ${what}`,
    date: view.since ? (view.once ? view.since : `Since ${view.since}`) : "",
    gift: view.giftFrom ? `A gift from ${view.giftFrom}` : "",
  };
}
