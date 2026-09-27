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

// Contact form: checks fields in the browser, then sends the enquiry to the cloud.
const form = document.getElementById("contact-form") as HTMLFormElement | null;
const openedAt = Date.now();
if (form) {
  const fields = document.getElementById("contact-fields")!;
  const done = document.getElementById("contact-done")!;
  const errorBox = document.getElementById("contact-error")!;
  const submit = document.getElementById("contact-submit") as HTMLButtonElement;
  const labels: Record<string, string> = {
    name: "your name",
    hotelName: "the hotel name",
    email: "a valid email address",
    message: "a message of at least 10 characters",
    rooms: "a number of rooms from 1 to 5000",
  };
  const showError = (text: string) => {
    errorBox.textContent = text;
    errorBox.hidden = !text;
  };
  const mark = (names: string[]) => {
    for (const el of form.querySelectorAll<HTMLElement>(
      "input, textarea, select",
    ))
      el.toggleAttribute(
        "aria-invalid",
        names.includes((el as HTMLInputElement).name),
      );
    form.querySelector<HTMLElement>("[aria-invalid]")?.focus();
  };
  // A field stops showing as wrong as soon as it is corrected.
  form.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.hasAttribute("aria-invalid") && el.checkValidity()) {
      el.removeAttribute("aria-invalid");
      if (!form.querySelector("[aria-invalid]")) showError("");
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const invalid = [
      ...form.querySelectorAll<HTMLInputElement>("input, textarea"),
    ]
      .filter((el) => el.name !== "website" && !el.checkValidity())
      .map((el) => el.name);
    if (invalid.length) {
      mark(invalid);
      showError(`Please add ${invalid.map((n) => labels[n] ?? n).join(", ")}.`);
      return;
    }
    mark([]);
    const data = Object.fromEntries(new FormData(form).entries()) as Record<
      string,
      string
    >;
    const body: Record<string, unknown> = { openedMs: Date.now() - openedAt };
    for (const [k, v] of Object.entries(data)) if (v.trim()) body[k] = v.trim();
    if (body.rooms) body.rooms = Number(body.rooms);
    submit.disabled = true;
    submit.textContent = "Sending…";
    try {
      const res = await fetch("/api/public/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok) {
        const names: string[] = (reply.fields ?? []).map(
          (f: { path: string[] }) => f.path[0],
        );
        if (names.length) {
          mark(names);
          showError(
            `Please check ${names.map((n) => labels[n] ?? n).join(", ")}.`,
          );
        } else
          showError(reply.error ?? "Something went wrong. Please try again.");
        return;
      }
      form.reset();
      fields.hidden = true;
      done.hidden = false;
      done.focus();
    } catch {
      showError(
        "You appear to be offline. Please check your connection and try again.",
      );
    } finally {
      submit.disabled = false;
      submit.textContent = "Request my demo";
    }
  });
  document.getElementById("contact-again")?.addEventListener("click", () => {
    done.hidden = true;
    fields.hidden = false;
    form.querySelector<HTMLInputElement>("input")?.focus();
  });
}
