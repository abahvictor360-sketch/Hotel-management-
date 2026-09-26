import { useSyncExternalStore } from "react";
import {
  DEFAULT_PRIMARY,
  themeCss,
} from "../../../packages/core/src/brand-colour";
// The hotel's branding as the browser applies it: colours, name, logo and contact details.
// The hub, the owner dashboard and the booking site all set it from their own API.
export type Brand = {
  name: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  logoUrl: string;
  primaryColor: string;
};
export const defaultBrand: Brand = {
  name: "Hotel Hub",
  tagline: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoUrl: "",
  primaryColor: DEFAULT_PRIMARY,
};
const CACHE = "hotel-brand";
let current = defaultBrand;
const listeners = new Set<() => void>();
function styleTag() {
  let tag = document.getElementById("brand-theme") as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = "brand-theme";
    document.head.appendChild(tag);
  }
  return tag;
}
// Re-colours the app. Used for live preview in settings as well as for the saved brand.
export function applyColour(primaryColor: string) {
  styleTag().textContent = themeCss(primaryColor);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", primaryColor);
}
function apply(b: Brand, title: string | undefined) {
  applyColour(b.primaryColor);
  if (title !== undefined) document.title = title;
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (b.logoUrl) {
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
    }
    icon.href = b.logoUrl;
  }
}
export function setBrand(
  value: Partial<Brand>,
  options: { remember?: boolean; title?: string } = {},
) {
  current = { ...defaultBrand, ...pick(value) };
  apply(current, options.title ?? current.name);
  if (options.remember)
    try {
      localStorage.setItem(CACHE, JSON.stringify(current));
    } catch {
      /* storage full or blocked: the brand still applies for this visit */
    }
  listeners.forEach((l) => l());
}
// The hub remembers its brand, so a reload paints in the hotel's colours before the
// API answers, and works offline.
export function restoreBrand() {
  try {
    const saved = localStorage.getItem(CACHE);
    if (saved) setBrand(JSON.parse(saved) as Partial<Brand>);
  } catch {
    /* no cached brand */
  }
}
function pick(v: Partial<Brand>): Partial<Brand> {
  const out: Partial<Brand> = {};
  for (const k of Object.keys(defaultBrand) as (keyof Brand)[])
    if (typeof v[k] === "string") out[k] = v[k];
  return out;
}
export function useBrand() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
// Shrinks an uploaded image to a logo that fits the header, receipts and the setting size
// limit. PNG keeps transparency; larger results fall back to WebP, then JPEG.
export async function logoFromFile(file: File, maxChars: number) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG or WebP image.");
  // Read as a data URL: the app's image policy allows data: but not blob: URLs.
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("That image could not be read."));
    i.src = url;
  });
  for (const [w, h] of [
    [480, 240],
    [320, 160],
    [200, 100],
  ]) {
    const scale = Math.min(1, w / img.naturalWidth, h / img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const [type, quality] of [
      ["image/png", undefined],
      ["image/webp", 0.9],
      ["image/jpeg", 0.88],
    ] as const) {
      let source = canvas;
      if (type === "image/jpeg") {
        // JPEG has no transparency: put the logo on white, not black.
        source = document.createElement("canvas");
        source.width = canvas.width;
        source.height = canvas.height;
        const flat = source.getContext("2d")!;
        flat.fillStyle = "#ffffff";
        flat.fillRect(0, 0, source.width, source.height);
        flat.drawImage(canvas, 0, 0);
      }
      const data = source.toDataURL(type, quality);
      // Browsers without WebP encoding return PNG instead; skip those repeats.
      if (!data.startsWith(`data:${type}`)) continue;
      if (data.length <= maxChars) return data;
    }
  }
  throw new Error("That image is too detailed to use as a logo.");
}
