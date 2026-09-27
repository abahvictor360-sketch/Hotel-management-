// Marketing page behaviour: mobile menu and the product tour tabs. Everything works
// without this script; it only adds convenience.
const menu = document.getElementById("menu");
const links = document.getElementById("nav-links");
menu?.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  links?.classList.toggle("open", open);
});
links?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).tagName === "A") {
    menu?.setAttribute("aria-expanded", "false");
    links.classList.remove("open");
  }
});

const tabs = [
  ...document.querySelectorAll<HTMLButtonElement>(".tour-tabs [role=tab]"),
];
const img = document.getElementById("tour-img") as HTMLImageElement | null;
const caption = document.getElementById("tour-caption");
function select(tab: HTMLButtonElement) {
  if (!img || !caption) return;
  for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
  img.classList.add("fading");
  const next = new Image();
  next.src = `/landing/${tab.dataset.shot}.webp`;
  next.onload = () => {
    img.src = next.src;
    img.alt = `Hotel Hub ${tab.textContent?.toLowerCase()} screen`;
    caption.textContent = tab.dataset.caption ?? "";
    img.classList.remove("fading");
  };
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => select(tab));
  // Arrow keys move between tabs, as screen reader users expect.
  tab.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const target = tabs[(i + step + tabs.length) % tabs.length];
    target.focus();
    select(target);
  });
});

const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());
