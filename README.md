# Cover

Monthly sponsor pages for nonprofits. Supporters pick something real to follow (an animal, a program, a room), give monthly through the nonprofit's own donation page, and get updates. Every gift goes into the nonprofit's general fund.

## What's in this folder
- `docs/`: the website. GitHub Pages will publish this folder.
  - `give.html`: the sponsor page template. `?org=rescue`, `?org=pantry`, `?org=youth` open the demo nonprofits. Add `&reset=1` to clear test sponsors.
  - `js/orgs.js`: each nonprofit's details (the only file a new nonprofit needs filled in).
  - `js/sponsor.js`: the sign-up rules. `js/store.js`: where sponsors are saved (this browser only for now; Supabase next).
  - `js/give.js`: draws the page and runs the sponsor pop-up.
- `tests/`: tests for the rules and saving.
- `design/`: the locked look and mockups (`design/README.md`).
- `company/`: private business files (pitch, research, brand, decks). Never uploaded to GitHub.

The site is JavaScript because it runs in visitors' browsers, which can't run Python. Python is used for the tools (screenshots, decks).

## Run it on your laptop
```bash
python -m http.server 8765 --bind 127.0.0.1
```
Then open http://127.0.0.1:8765/docs/give.html?org=rescue

## Run the tests
```bash
npm test
```
