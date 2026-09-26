import { z } from "zod";
import { DEFAULT_PRIMARY } from "./brand-colour.js";
export {
  DEFAULT_PRIMARY,
  themeCss,
  themeTokens,
  contrast,
} from "./brand-colour.js";
// Hotel branding: what a hotel customises about how the system looks to staff, guests and
// owners. Stored in the replicated `branding` setting, so the hub, the booking site and the
// owner dashboard all read the same record.
// Logos are stored inline so they work offline and under a strict image CSP. The browser
// shrinks uploads before saving; this bound keeps one setting row small enough to sync.
export const MAX_LOGO_CHARS = 200_000;
const logo = z
  .string()
  .max(MAX_LOGO_CHARS, "The logo is too large. Use an image under 140 KB.")
  .refine(
    (v) =>
      v === "" ||
      /^\/assets\/[\w./-]+$/.test(v) ||
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v),
    "Upload a PNG, JPEG or WebP logo.",
  );
const hex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "Use a colour like #1b8a4f.")
  .transform((v) => v.toLowerCase());
const optionalText = (max: number) => z.string().trim().max(max).default("");
export const brandingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    tagline: optionalText(160),
    address: z.string().max(500),
    phone: optionalText(40),
    email: z
      .union([z.literal(""), z.string().trim().email().max(160)])
      .default(""),
    website: z
      .union([z.literal(""), z.string().trim().url().max(200)])
      .refine(
        (v) => v === "" || /^https?:\/\//.test(v),
        "Use an http(s) address.",
      )
      .default(""),
    logoUrl: logo.default(""),
    primaryColor: hex.default(DEFAULT_PRIMARY),
  })
  .strict();
export type Branding = z.infer<typeof brandingSchema>;
// Older records hold only name, address and logoUrl; fill the rest with defaults.
export function readBranding(value: unknown, fallbackName: string): Branding {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const parsed = brandingSchema.safeParse({
    name: fallbackName,
    address: "",
    ...v,
  });
  return parsed.success
    ? parsed.data
    : brandingSchema.parse({
        name: String(v.name || fallbackName),
        address: "",
      });
}
// The subset guests and owners see. Staff-only details stay on the hub.
export function publicBranding(b: Branding) {
  const {
    name,
    tagline,
    address,
    phone,
    email,
    website,
    logoUrl,
    primaryColor,
  } = b;
  return {
    name,
    tagline,
    address,
    phone,
    email,
    website,
    logoUrl,
    primaryColor,
  };
}
