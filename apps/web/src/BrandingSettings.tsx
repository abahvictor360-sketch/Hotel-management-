import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  applyColour,
  logoFromFile,
  setBrand,
  useBrand,
  type Brand,
} from "./brand";
import { DEFAULT_PRIMARY } from "../../../packages/core/src/brand-colour";
// Matches MAX_LOGO_CHARS in packages/core/src/branding.ts.
const MAX_LOGO_CHARS = 200_000;
const swatches = [
  ["Emerald", "#1b8a4f"],
  ["Ocean", "#0e6ba8"],
  ["Royal", "#3b3fb6"],
  ["Plum", "#7a2e8a"],
  ["Ruby", "#b4233c"],
  ["Terracotta", "#c2571a"],
  ["Gold", "#a87b12"],
  ["Charcoal", "#2f3a35"],
] as const;
// Hotel customisation: identity, logo, colour, contact details and receipt wording.
// Everything saves to replicated settings, so the booking site and owner dashboard follow.
export function BrandingSettings({
  canWrite,
  perform,
  notify,
}: {
  canWrite: boolean;
  perform: (fn: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
}) {
  const saved = useBrand();
  const [draft, setDraft] = useState<Brand>(saved);
  const [footer, setFooter] = useState("");
  const [logoError, setLogoError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(saved), [saved]);
  useEffect(() => {
    void api<{ key: string; value: { text?: string } }[]>("/settings")
      .then((rows) =>
        setFooter(
          rows.find((r) => r.key === "receipt_footer")?.value.text ?? "",
        ),
      )
      .catch(() => {});
  }, []);
  // Live preview while choosing; leaving the page restores the saved colour.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => applyColour(draft.primaryColor), [draft.primaryColor]);
  useEffect(() => () => applyColour(savedRef.current.primaryColor), []);
  const set = <K extends keyof Brand>(k: K, v: Brand[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  async function save() {
    await perform(async () => {
      await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "branding", value: draft }),
      });
      setBrand(await api("/branding"), { remember: true });
      notify(
        "Hotel branding saved. Guests and owners see it after the next sync.",
      );
    });
  }
  return (
    <div className="stack">
      <section className="panel brand-preview-panel">
        <div className="brand-preview" aria-label="Preview">
          <div className="brand-preview-logo">
            {draft.logoUrl ? (
              <img src={draft.logoUrl} alt="Logo preview" />
            ) : (
              <span>{draft.name.slice(0, 1).toUpperCase() || "H"}</span>
            )}
          </div>
          <div>
            <strong>{draft.name || "Hotel name"}</strong>
            <small>{draft.tagline || "Your tagline appears here"}</small>
          </div>
          <div className="row brand-preview-actions">
            <button type="button" tabIndex={-1}>
              Primary button
            </button>
            <button type="button" className="secondary" tabIndex={-1}>
              Secondary
            </button>
          </div>
        </div>
      </section>
      <div className="grid">
        <section className="panel">
          <h2>Logo</h2>
          <p className="muted">
            PNG, JPEG or WebP. Wide logos on a transparent background look best.
            It is resized for you.
          </p>
          <div className="logo-drop">
            {draft.logoUrl ? (
              <img src={draft.logoUrl} alt="Current logo" />
            ) : (
              <span className="muted">No logo yet</span>
            )}
          </div>
          {logoError ? (
            <p className="error-message" role="alert">
              {logoError}
            </p>
          ) : null}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setLogoError("");
              logoFromFile(f, MAX_LOGO_CHARS)
                .then((data) => set("logoUrl", data))
                .catch((err: Error) => setLogoError(err.message));
            }}
          />
          <div className="row form-actions">
            <button
              type="button"
              disabled={!canWrite}
              onClick={() => file.current?.click()}
            >
              {draft.logoUrl ? "Replace logo" : "Upload logo"}
            </button>
            {draft.logoUrl ? (
              <button
                type="button"
                className="secondary"
                disabled={!canWrite}
                onClick={() => set("logoUrl", "")}
              >
                Remove
              </button>
            ) : null}
          </div>
        </section>
        <section className="panel">
          <h2>Brand colour</h2>
          <p className="muted">
            Used for buttons, the selected menu item and highlights. It is
            adjusted slightly where needed so text stays readable in light and
            dark mode.
          </p>
          <div
            className="swatches"
            role="radiogroup"
            aria-label="Preset colours"
          >
            {swatches.map(([label, colour]) => (
              <button
                key={colour}
                type="button"
                role="radio"
                aria-checked={draft.primaryColor === colour}
                aria-label={label}
                title={label}
                className="swatch"
                style={{ background: colour }}
                disabled={!canWrite}
                onClick={() => set("primaryColor", colour)}
              />
            ))}
          </div>
          <div className="row colour-row">
            <input
              type="color"
              aria-label="Custom colour"
              value={draft.primaryColor}
              disabled={!canWrite}
              onChange={(e) => set("primaryColor", e.target.value)}
            />
            <input
              aria-label="Colour code"
              value={draft.primaryColor}
              maxLength={7}
              disabled={!canWrite}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (/^#[0-9a-f]{6}$/i.test(v))
                  set("primaryColor", v.toLowerCase());
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={!canWrite || draft.primaryColor === DEFAULT_PRIMARY}
              onClick={() => set("primaryColor", DEFAULT_PRIMARY)}
            >
              Default
            </button>
          </div>
        </section>
      </div>
      <section className="panel">
        <h2>Hotel details</h2>
        <p className="muted">
          Shown on the sign-in screen, receipts, the booking website and the
          owner dashboard.
        </p>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor="b-name">Hotel name</label>
            <input
              id="b-name"
              value={draft.name}
              maxLength={120}
              required
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="b-tagline">Tagline</label>
            <input
              id="b-tagline"
              value={draft.tagline}
              maxLength={160}
              placeholder="Comfort in the heart of the city"
              onChange={(e) => set("tagline", e.target.value)}
            />
          </div>
          <div className="wide">
            <label htmlFor="b-address">Address</label>
            <textarea
              id="b-address"
              value={draft.address}
              maxLength={500}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="b-phone">Phone</label>
            <input
              id="b-phone"
              type="tel"
              value={draft.phone}
              maxLength={40}
              onChange={(e) => set("phone", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="b-email">Email</label>
            <input
              id="b-email"
              type="email"
              value={draft.email}
              maxLength={160}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div className="wide">
            <label htmlFor="b-website">Website</label>
            <input
              id="b-website"
              type="url"
              value={draft.website}
              maxLength={200}
              placeholder="https://"
              onChange={(e) => set("website", e.target.value)}
            />
          </div>
          <div className="wide row form-actions">
            <button disabled={!canWrite || !changed}>Save branding</button>
            <button
              type="button"
              className="secondary"
              disabled={!changed}
              onClick={() => setDraft(saved)}
            >
              Discard changes
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Receipt message</h2>
        <p className="muted">Printed at the bottom of every receipt.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await api("/settings", {
                method: "PUT",
                body: JSON.stringify({
                  key: "receipt_footer",
                  value: { text: footer },
                }),
              });
              notify("Receipt message saved.");
            });
          }}
        >
          <label htmlFor="b-footer">Message</label>
          <textarea
            id="b-footer"
            value={footer}
            maxLength={500}
            placeholder="Thank you for staying with us."
            onChange={(e) => setFooter(e.target.value)}
          />
          <button disabled={!canWrite}>Save receipt message</button>
        </form>
      </section>
    </div>
  );
}
