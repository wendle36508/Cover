# Cover design (locked Nov 13, 2026)

The look Tanner approved for both Cover's company site and the nonprofit sponsor page.

## Look
- **Feel:** a real software company, not a toy. Plain cards, real photos, a standard top menu, lots of white space. No tilted cards, tape, handwriting or cartoon art.
- **Type:** Bricolage Grotesque everywhere. Instrument Serif only for one big quote per page.
- **Color:** white and soft gray backgrounds, near-black text, bright green `#22C67A` for buttons, bars and checks, dark green `#0C2B24` for one feature section per page.
- **Photos:** real photography. Stock photos from Unsplash are placeholders (`photos/CREDITS.md`) until nonprofits send their own.

## Pages
- `mockups/company.html`: Cover's site, written for every kind of nonprofit.
- `mockups/donor.html`: one sponsor-page template. Each nonprofit fills in `mockups/orgs.js` (name, headline, photos, what supporters follow, questions). Demo versions: `?org=pantry`, `?org=youth`, `?org=rescue`.

## Rules the design follows
- Money goes into one fund; supporters "follow" an animal or a program. The page says so plainly.
- People served (families, kids) are never put on display. Those nonprofits let supporters follow programs, not people.
- No made-up testimonials, partner logos or badges. Example businesses are labeled as examples.
- Every stat has its source on the page.

## Screenshots
`python design/shoot.py` saves desktop and phone shots of every page and version to `design/shots/`.
