import { useRef, useState } from "react";
import { api } from "./api";
import {
  importColumns,
  templateCsv,
  type ImportKind,
} from "../../../packages/core/src/csv-import";
type Result = {
  kind: ImportKind;
  dryRun: boolean;
  create: number;
  skipped: { row: number; reason: string }[];
  errors: { row: number; message: string }[];
  notes: string[];
  imported: boolean;
};
const kinds: {
  id: ImportKind;
  label: string;
  about: string;
  permission: string;
}[] = [
  {
    id: "rooms",
    label: "Rooms",
    about:
      "One row per room. New room types are created from the first row that names them, which must include a nightly rate.",
    permission: "settings.write",
  },
  {
    id: "menu",
    label: "Menu and services",
    about:
      "Items sold by the restaurant, bar, laundry, room service and other departments, with their price.",
    permission: "settings.write",
  },
  {
    id: "guests",
    label: "Guests",
    about:
      "Your existing guest list. Guests already on the hub (same email or phone) are skipped.",
    permission: "frontdesk.write",
  },
];
// Bulk import from a spreadsheet saved as CSV. The hub checks the whole file first and
// shows every problem by row; nothing is written until the file is clean and confirmed.
export function ImportData({
  permissions,
  writable,
}: {
  permissions: string[];
  writable: boolean;
}) {
  const allowed = kinds.filter((k) => permissions.includes(k.permission));
  const [kind, setKind] = useState<ImportKind>(allowed[0]?.id ?? "rooms");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const meta = kinds.find((k) => k.id === kind)!;
  async function send(text: string, dryRun: boolean) {
    setBusy(true);
    setError("");
    try {
      setResult(
        await api<Result>(`/import/${kind}`, {
          method: "POST",
          body: JSON.stringify({ csv: text, dryRun }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }
  function choose(k: ImportKind) {
    setKind(k);
    setFile(null);
    setResult(null);
    setError("");
  }
  function downloadTemplate() {
    const url = `data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv(kind))}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `hotel-hub-${kind}-template.csv`;
    a.click();
  }
  if (!allowed.length)
    return (
      <section className="panel">
        <p className="muted">Your role cannot import records.</p>
      </section>
    );
  const clean = result && result.errors.length === 0;
  return (
    <div className="stack">
      <section className="panel">
        <div className="row import-kinds" role="tablist">
          {allowed.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={kind === k.id}
              className={kind === k.id ? "" : "secondary"}
              onClick={() => choose(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="muted">{meta.about}</p>
        <div className="import-columns">
          {importColumns[kind].map((c) => (
            <span key={c.key} className={c.required ? "required" : ""}>
              {c.key}
              {c.required ? " *" : ""}
            </span>
          ))}
        </div>
        <p className="muted small">
          * required. Save your spreadsheet as CSV (comma or semicolon). Other
          heading names such as "Room No" or "Price" are recognised.
        </p>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 230_000) {
              setError(
                "That file is too large. Split it into files under 1,000 rows.",
              );
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              const text = String(reader.result);
              setFile({ name: f.name, text });
              void send(text, true);
            };
            reader.onerror = () => setError("That file could not be read.");
            reader.readAsText(f);
          }}
        />
        <div className="row form-actions">
          <button
            type="button"
            disabled={!writable || busy}
            onClick={() => input.current?.click()}
          >
            {file ? "Choose another file" : "Choose CSV file"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={downloadTemplate}
          >
            Download template
          </button>
        </div>
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {file && result ? (
        <section className="panel">
          <h2>
            {result.imported
              ? "Import complete"
              : result.errors.length
                ? "Fix these rows, then upload again"
                : result.create
                  ? "Ready to import"
                  : "Nothing new to import"}
          </h2>
          <p className="muted">{file.name}</p>
          <div className="import-summary">
            <div>
              <strong>{result.create}</strong>
              <span>{result.imported ? "added" : "to add"}</span>
            </div>
            <div>
              <strong>{result.skipped.length}</strong>
              <span>already on the hub</span>
            </div>
            <div className={result.errors.length ? "bad" : ""}>
              <strong>{result.errors.length}</strong>
              <span>need fixing</span>
            </div>
          </div>
          {result.notes.map((n) => (
            <p key={n} className="notice">
              {n}
            </p>
          ))}
          {result.errors.length ? (
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {result.errors.slice(0, 200).map((e) => (
                  <tr key={`${e.row}-${e.message}`}>
                    <td>{e.row}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {result.skipped.length && !result.errors.length ? (
            <details>
              <summary>Rows skipped</summary>
              <ul>
                {result.skipped.slice(0, 200).map((s) => (
                  <li key={s.row}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {clean && !result.imported && result.create > 0 ? (
            <div className="row form-actions">
              <button
                type="button"
                disabled={!writable || busy}
                onClick={() => void send(file.text, false)}
              >
                Import {result.create}{" "}
                {result.create === 1 ? "record" : "records"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
