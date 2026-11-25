// dashboard-demo.js - dashboard.html?demo=1: the owner dashboard with a sample rescue, sample sponsors
// and a sample year of income, so it can be shown (Demo Day) and checked without signing in.
// Nothing here is real, the page says so, and nothing pressed is saved or sent (no one is signed in,
// so Cover's database refuses every change).

export const DEMO = new URLSearchParams(location.search).get("demo") === "1";

const PHOTOS = "https://covergiving.com/photos/";
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

const DOGS = [
  ["d1", "Bella", "dog-smile.jpg", { Age: "2 years", Breed: "Lab mix", Sex: "Female" }],
  ["d2", "Moose", "dog-brindle.jpg", { Age: "4 years", Breed: "Boxer mix", Sex: "Male" }],
  ["d3", "Pepper", "dog-puppy.jpg", { Age: "5 months", Breed: "Terrier mix", Sex: "Female" }],
  ["d4", "Gus", "dog-armchair.jpg", { Age: "9 years", Breed: "Beagle", Sex: "Male" }],
  ["d5", "Juno", "dog-harness.jpg", { Age: "1 year", Breed: "Shepherd mix", Sex: "Female" }],
  ["d6", "Otis", "dog-looking.jpg", { Age: "3 years", Breed: "Hound mix", Sex: "Male" }],
];

/** Everything the dashboard's state needs, for the sample rescue. */
export function demoDashboard() {
  const nonprofit = {
    id: "demo-nonprofit", name: "Harbor Paws Rescue", slug: "harbor-paws", kind: "animal", is_live: true, new_page: true,
    stripe_account_id: null, cover_fee_on: false, monthly_price_cents: 2500, monthly_goal_cents: 200000, is_test: true,
    page: { navLabel: "Dogs" },
  };
  const items = DOGS.map(([id, name, photo, facts], i) => ({
    id, nonprofit_id: nonprofit.id, name, photo_url: `${PHOTOS}${photo}`, photo_focus_x: 50, photo_focus_y: 40, status: "active",
    sort_order: i, facts, badge: null, note: null, more_photos: [], created_at: ago(60 - i),
  }));
  const sponsor = (n, first, initial, itemIndex, cents, days, extra = {}) => ({
    id: `s${n}`, item_id: DOGS[itemIndex][0], first_name: first, last_initial: initial, email: `${first.toLowerCase()}@example.com`, business_name: null,
    monthly_cents: cents, amount_cents: cents, interval: "month", status: "active", updates_off: false, show_name: true, wall_hidden: false,
    created_at: ago(days), ...extra,
  });
  const sponsors = [
    sponsor(1, "Sarah", "K", 0, 2500, 2),
    sponsor(2, "Jon", "M", 1, 2500, 9),
    sponsor(3, "Ana", "R", 0, 5000, 21),
    sponsor(4, "Lee", null, 2, 1500, 33),
    sponsor(5, "Corner Cafe", null, 3, 10000, 40, { business_name: "Corner Cafe" }),
    sponsor(6, "Priya", "S", 4, 2500, 55),
    sponsor(7, "Tom", "B", 1, 2000, 70),
    sponsor(8, "Mia", null, 5, 1000, 4, { interval: "once", status: "gave_once", monthly_cents: 1000, amount_cents: 1000 }),
  ];
  return {
    user: { id: "demo-user", email: "demo@example.com" }, role: "owner", admin: false,
    memberships: [{ nonprofit_id: nonprofit.id, role: "owner", name: nonprofit.name }],
    nonprofit, items, sponsors,
  };
}

/** A sample year of money in (same shape as the stripe-connect "income" answer), growing over the year. */
export function demoIncome(now = new Date()) {
  const months = [];
  for (let back = 11; back >= 0; back -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const step = 11 - back;
    const sponsorCents = step < 3 ? 0 : (step - 2) * 2400 + (step % 2) * 800;
    const oneTimeCents = [0, 2500, 0, 5000, 1000, 0, 3000, 0, 2500, 1500, 0, 1000][step];
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: MONTHS[d.getMonth()], year: d.getFullYear(),
      sponsorCents, oneTimeCents, totalCents: sponsorCents + oneTimeCents });
  }
  const totalCents = months.reduce((sum, m) => sum + m.totalCents, 0);
  return { months, totalCents, thisMonthCents: months[11].totalCents, complete: true };
}
