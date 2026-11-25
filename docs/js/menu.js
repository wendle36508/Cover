// menu.js - the phone menu on Cover's own pages (donor side and nonprofit side, Nov 25, 2026).
// On phones the header shows just the logo and "Menu"; tapping it opens the links underneath.

const button = document.querySelector(".nav .menu-btn");
const menu = document.getElementById("phone-menu");
if (button && menu) {
  button.addEventListener("click", () => {
    const open = menu.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Close" : "Menu";
  });
  for (const link of menu.querySelectorAll("a")) link.addEventListener("click", () => menu.classList.remove("open"));
}
