import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brandingSchema,
  readBranding,
  publicBranding,
  themeTokens,
  themeCss,
  contrast,
  DEFAULT_PRIMARY,
  MAX_LOGO_CHARS,
} from "../packages/core/src/branding.js";
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAf+dVJAAAAABJRU5ErkJggg==";

test("older branding records gain defaults", () => {
  const b = readBranding(
    { name: "Palm Inn", address: "1 Marina", logoUrl: "" },
    "Tenant",
  );
  assert.equal(b.name, "Palm Inn");
  assert.equal(b.primaryColor, DEFAULT_PRIMARY);
  assert.equal(b.tagline, "");
  assert.equal(readBranding(null, "Tenant").name, "Tenant");
});

test("branding accepts uploaded logos and brand colours", () => {
  const b = brandingSchema.parse({
    name: "Palm Inn",
    address: "",
    logoUrl: png,
    primaryColor: "#B4233C",
    website: "https://palm.example",
    email: "desk@palm.example",
  });
  assert.equal(b.primaryColor, "#b4233c");
  assert.equal(b.logoUrl, png);
});

test("branding rejects unsafe or oversized logos and bad values", () => {
  const base = { name: "Palm Inn", address: "" };
  for (const logoUrl of [
    "data:image/svg+xml;base64,PHN2Zz4=",
    "https://evil.example/logo.png",
    "javascript:alert(1)",
    "data:image/png;base64," + "A".repeat(MAX_LOGO_CHARS),
  ])
    assert.equal(brandingSchema.safeParse({ ...base, logoUrl }).success, false);
  assert.equal(
    brandingSchema.safeParse({ ...base, primaryColor: "red" }).success,
    false,
  );
  assert.equal(
    brandingSchema.safeParse({ ...base, website: "ftp://x.example" }).success,
    false,
  );
  assert.equal(brandingSchema.safeParse({ ...base, extra: 1 }).success, false);
});

test("public branding omits nothing a guest needs and adds nothing else", () => {
  const b = readBranding({ name: "Palm Inn", address: "x" }, "T");
  assert.deepEqual(Object.keys(publicBranding(b)).sort(), [
    "address",
    "email",
    "logoUrl",
    "name",
    "phone",
    "primaryColor",
    "tagline",
    "website",
  ]);
});

test("theme tokens stay readable for any brand colour", () => {
  for (const c of [
    "#1b8a4f",
    "#2e9e5b",
    "#e63c3c",
    "#ffe600",
    "#f5f5f5",
    "#000000",
    "#0e6ba8",
    "#ff69b4",
  ]) {
    const { light, dark } = themeTokens(c);
    assert.ok(contrast(light.primary, "#ffffff") >= 3, `${c} light surface`);
    assert.ok(contrast(dark.primary, "#141916") >= 3, `${c} dark surface`);
    assert.ok(
      contrast(light.primaryText, light.primary) >= 4.5,
      `${c} light text`,
    );
    assert.ok(
      contrast(dark.primaryText, dark.primary) >= 4.5,
      `${c} dark text`,
    );
  }
  // A colour that already works is used as chosen; the default keeps the stylesheet's.
  assert.equal(themeTokens("#0e6ba8").light.primary, "#0e6ba8");
  assert.match(themeCss("#0e6ba8"), /--primary:#0e6ba8;/);
  assert.equal(themeCss(DEFAULT_PRIMARY), "");
});
