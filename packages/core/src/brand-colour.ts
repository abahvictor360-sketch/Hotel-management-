// Brand colour maths, without dependencies so the browser bundle can use it directly.
export const DEFAULT_PRIMARY = "#1b8a4f";
// Derives readable theme tokens from one brand colour.
type Rgb = [number, number, number];
const toRgb = (h: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) =>
  "#" +
  c
    .map((x) =>
      Math.round(Math.min(255, Math.max(0, x)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;
function luminance([r, g, b]: Rgb) {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(toRgb(a)), luminance(toRgb(b))].sort(
    (m, n) => n - m,
  );
  return (x + 0.05) / (y + 0.05);
}
const WHITE: Rgb = [255, 255, 255],
  BLACK: Rgb = [0, 0, 0];
// Moves a colour toward white or black until it reaches the contrast target against `bg`.
function reach(colour: Rgb, bg: string, target: number, toward: Rgb) {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = toHex(mix(colour, toward, t));
    if (contrast(c, bg) >= target) return c;
  }
  return toHex(toward);
}
const INK = "#0f1411";
const textOn = (bg: string) =>
  contrast("#ffffff", bg) >= contrast(INK, bg) ? "#ffffff" : INK;
export type ThemeTokens = {
  primary: string;
  primaryText: string;
  ring: string;
};
// Buttons and active items must stand out from the surface (3:1, WCAG non-text contrast)
// and carry readable labels (4.5:1). The brand colour moves only as far as needed: toward
// black on light surfaces, toward white on dark ones, keeping its hue.
function tokens(
  base: Rgb,
  surface: string,
  toward: Rgb,
  ringInto: Rgb,
): ThemeTokens {
  let primary = reach(base, surface, 3, toward);
  if (contrast(textOn(primary), primary) < 4.5) {
    // Mid-tones suit neither white nor ink labels: deepen for white text on light
    // surfaces, lighten for ink text on dark ones.
    const label = toward === BLACK ? "#ffffff" : INK;
    primary = reach(toRgb(primary), label, 4.5, toward);
  }
  return {
    primary,
    primaryText: textOn(primary),
    ring: toHex(mix(toRgb(primary), ringInto, 0.45)),
  };
}
// Light surfaces are white and dark surfaces #141916, as in the stylesheet.
export function themeTokens(primaryColor: string) {
  const base = toRgb(
    /^#[0-9a-f]{6}$/i.test(primaryColor) ? primaryColor : DEFAULT_PRIMARY,
  );
  return {
    light: tokens(base, "#ffffff", BLACK, WHITE),
    dark: tokens(base, "#141916", WHITE, [20, 25, 22]),
  };
}
// CSS that re-colours the app for a brand. Selectors mirror the theme rules in styles.css:
// explicit data-theme wins; otherwise the system preference decides. The default colour
// keeps the stylesheet's own hand-tuned light and dark values.
export function themeCss(primaryColor: string) {
  if (primaryColor.toLowerCase() === DEFAULT_PRIMARY) return "";
  const { light, dark } = themeTokens(primaryColor);
  const vars = (t: ThemeTokens) =>
    `--primary:${t.primary};--primary-text:${t.primaryText};--ring:${t.ring};`;
  return [
    `:root{${vars(light)}}`,
    `:root[data-theme="dark"]{${vars(dark)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars(dark)}}}`,
  ].join("\n");
}
