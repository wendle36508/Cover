// Made-up demo content shared by the three design mockups. Not a real rescue or real dogs.
// Photos are placeholders until the rescue sends real ones.

const RESCUE = {
  name: "Harbor Paws Rescue",
  town: "Portland, Maine",
  monthlyGoal: 2000,
  monthlyCovered: 950,
  sponsorPrice: 25,
};

const DOGS = [
  { name: "Bella", days: 94, sponsors: 2, tone: "#E8D5BF", note: "Steals tennis balls, gives them back" },
  { name: "Moose", days: 71, sponsors: 1, tone: "#D9E4DD", note: "90 pounds of gentle" },
  { name: "Pepper", days: 58, sponsors: 3, tone: "#EEDFD0", note: "Shy for a day, silly forever" },
  { name: "Juno", days: 40, sponsors: 4, tone: "#E2DDD3", note: "Loves car rides with the window down" },
  { name: "Rocket", days: 22, sponsors: 5, tone: "#DCE2E6", note: "Three legs, zero brakes" },
  { name: "Tilly", days: 9, sponsors: 6, tone: "#EADCCB", note: "Sleeps like it's her job" },
];

// A simple line-drawn dog face standing in for a photo.
const DOG_FACE = `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M27 30 C12 30 9 56 20 64 C25 54 29 44 33 35 Z" fill="currentColor" opacity=".55"/>
  <path d="M73 30 C88 30 91 56 80 64 C75 54 71 44 67 35 Z" fill="currentColor" opacity=".55"/>
  <ellipse cx="50" cy="53" rx="25" ry="27" fill="currentColor" opacity=".35"/>
  <circle cx="41" cy="49" r="3" fill="currentColor"/>
  <circle cx="59" cy="49" r="3" fill="currentColor"/>
  <ellipse cx="50" cy="61" rx="6" ry="4.5" fill="currentColor"/>
  <path d="M44 68 Q50 73 56 68" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/>
</svg>`;

const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="5,12.5 10,17 19,7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

const dollars = (n) => "$" + n.toLocaleString("en-US");
const sponsorSpots = Math.round(RESCUE.monthlyGoal / RESCUE.sponsorPrice);
const spotsFilled = Math.round(RESCUE.monthlyCovered / RESCUE.sponsorPrice);
