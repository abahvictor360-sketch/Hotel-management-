import { deflateRawSync } from "node:zlib";
// Report output formats. No third-party PDF or ZIP library: the hub must build these
// offline, and each writer is small enough to test byte for byte.

export type Column = { key: string; label: string; align?: "left" | "right" };
export type ReportTable = {
  title: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, string | number | null>;
  note?: string;
};
export type Metric = { label: string; value: string; hint?: string };
export type Report = {
  kind: string;
  title: string;
  hotel: { name: string; currency: string; timezone: string };
  from: string;
  to: string;
  generatedAt: string;
  source: "hub" | "cloud";
  metrics: Metric[];
  tables: ReportTable[];
  series?: { date: string; revenue: string; occupancy: string }[];
};

// Spreadsheet formula injection: a cell that starts with = + - @ or a control character
// is prefixed with an apostrophe. Plain signed numbers such as -1500.00 stay numeric.
const numeric = /^-?\d+(\.\d+)?$/;
export function csvCell(value: unknown) {
  let s = value === null || value === undefined ? "" : String(value);
  if (!numeric.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");
export function tableCsv(t: Pick<ReportTable, "columns" | "rows" | "totals">) {
  const lines = [csvLine(t.columns.map((c) => c.label))];
  for (const r of t.rows) lines.push(csvLine(t.columns.map((c) => r[c.key])));
  if (t.totals) lines.push(csvLine(t.columns.map((c) => t.totals![c.key])));
  return lines.join("\r\n");
}
// One file per report. Each table is a titled block so it still opens in a spreadsheet.
export function reportCsv(r: Report) {
  const head = [
    csvLine([r.title]),
    csvLine([r.hotel.name]),
    csvLine([`Period ${r.from} to ${r.to} (${r.hotel.timezone})`]),
    csvLine([
      `Amounts in ${r.hotel.currency}. Generated ${r.generatedAt} from the ${r.source}.`,
    ]),
  ];
  const blocks = [head.join("\r\n")];
  if (r.metrics.length)
    blocks.push(
      [
        csvLine(["Measure", "Value"]),
        ...r.metrics.map((m) => csvLine([m.label, m.value])),
      ].join("\r\n"),
    );
  for (const t of r.tables)
    blocks.push(`${csvLine([t.title])}\r\n${tableCsv(t)}`);
  // BOM so Excel opens UTF-8 names correctly.
  return `﻿${blocks.join("\r\n\r\n")}\r\n`;
}

// ---------- PDF ----------
// A4 landscape, built-in Helvetica (WinAnsiEncoding), so no font is embedded. Characters
// outside that encoding become "?". Currency symbols are therefore written as the code.
const W = 842,
  H = 595,
  M = 36;
const winAnsi: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x2c6: 0x88,
  0x2030: 0x89,
  0x160: 0x8a,
  0x2039: 0x8b,
  0x152: 0x8c,
  0x17d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x2dc: 0x98,
  0x2122: 0x99,
  0x161: 0x9a,
  0x203a: 0x9b,
  0x153: 0x9c,
  0x17e: 0x9e,
  0x178: 0x9f,
  0xd7: 0xd7,
};
function pdfBytes(s: string) {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out.push(c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : (winAnsi[c] ?? 0x3f));
  }
  return out;
}
function pdfString(s: string) {
  return `(${pdfBytes(s)
    .map((b) =>
      b === 0x28 || b === 0x29 || b === 0x5c
        ? `\\${String.fromCharCode(b)}`
        : b < 0x20 || b > 0x7e
          ? `\\${b.toString(8).padStart(3, "0")}`
          : String.fromCharCode(b),
    )
    .join("")})`;
}
// Helvetica advance widths (1/1000 em) for ASCII; other glyphs use an average width.
const widths =
  "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584"
    .split(",")
    .map(Number);
export function textWidth(s: string, size: number, bold = false) {
  let w = 0;
  for (const b of pdfBytes(s)) w += b >= 32 && b < 127 ? widths[b - 32] : 556;
  return (w * size * (bold ? 1.05 : 1)) / 1000;
}
function fit(s: string, max: number, size: number, bold = false) {
  if (textWidth(s, size, bold) <= max) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > max)
    t = t.slice(0, -1);
  return `${t}…`;
}
class Pages {
  pages: string[][] = [[]];
  y = H - M;
  get ops() {
    return this.pages[this.pages.length - 1];
  }
  newPage() {
    this.pages.push([]);
    this.y = H - M;
  }
  ensure(space: number) {
    if (this.y - space < M + 18) this.newPage();
  }
  text(x: number, y: number, s: string, size = 9, bold = false, grey = false) {
    this.ops.push(
      `${grey ? "0.4 0.4 0.4 rg" : "0 0 0 rg"} BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`,
    );
  }
  rect(x: number, y: number, w: number, h: number, shade: number) {
    this.ops.push(
      `${shade} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`,
    );
  }
  line(y: number) {
    this.ops.push(
      `0.8 G 0.5 w ${M} ${y.toFixed(2)} m ${W - M} ${y.toFixed(2)} l S`,
    );
  }
}
export function reportPdf(r: Report): Buffer {
  const p = new Pages();
  const cur = (s: string) => s.replace(/₦/g, "NGN ");
  const header = () => {
    p.text(M, p.y - 14, cur(r.title), 16, true);
    p.text(
      M,
      p.y - 30,
      cur(
        `${r.hotel.name} · ${r.from} to ${r.to} · ${r.hotel.timezone} · amounts in ${r.hotel.currency}`,
      ),
      9,
      false,
      true,
    );
    p.y -= 44;
    p.line(p.y);
    p.y -= 12;
  };
  header();
  if (r.metrics.length) {
    const per = 4,
      cw = (W - 2 * M) / per;
    for (let i = 0; i < r.metrics.length; i += per) {
      p.ensure(40);
      r.metrics.slice(i, i + per).forEach((m, j) => {
        const x = M + j * cw;
        p.rect(x, p.y - 34, cw - 8, 34, 0.95);
        p.text(x + 6, p.y - 12, fit(cur(m.label), cw - 20, 8), 8, false, true);
        p.text(x + 6, p.y - 27, fit(cur(m.value), cw - 20, 12, true), 12, true);
      });
      p.y -= 42;
    }
  }
  for (const t of r.tables) {
    p.ensure(50);
    p.y -= 8;
    p.text(M, p.y - 11, cur(t.title), 11, true);
    p.y -= 18;
    // Column widths from content, scaled to the page.
    const size = 8,
      natural = t.columns.map(
        (c) =>
          Math.max(
            textWidth(c.label, size, true),
            ...[...t.rows.slice(0, 200), ...(t.totals ? [t.totals] : [])].map(
              (row) => textWidth(cur(String(row[c.key] ?? "")), size),
            ),
          ) + 10,
      ),
      scale = Math.min(1.6, (W - 2 * M) / natural.reduce((a, b) => a + b, 0)),
      cols = natural.map((w) => w * scale);
    const tableWidth = cols.reduce((a, b) => a + b, 0);
    const row = (
      values: Record<string, unknown>,
      bold: boolean,
      shade?: number,
    ) => {
      if (shade !== undefined) p.rect(M, p.y - 13, tableWidth, 14, shade);
      let x = M;
      t.columns.forEach((c, i) => {
        const s = fit(
          cur(String(values[c.key] ?? "")),
          cols[i] - 8,
          size,
          bold,
        );
        const tx =
          c.align === "right"
            ? x + cols[i] - 4 - textWidth(s, size, bold)
            : x + 4;
        p.text(tx, p.y - 9.5, s, size, bold);
        x += cols[i];
      });
      p.y -= 14;
    };
    const head = () =>
      row(
        Object.fromEntries(t.columns.map((c) => [c.key, c.label])),
        true,
        0.9,
      );
    head();
    if (!t.rows.length) {
      p.text(M + 4, p.y - 9.5, "No records in this period.", size, false, true);
      p.y -= 14;
    }
    t.rows.forEach((values, i) => {
      if (p.y - 14 < M + 18) {
        p.newPage();
        header();
        head();
      }
      row(values, false, i % 2 ? 0.975 : undefined);
    });
    if (t.totals) {
      p.ensure(16);
      row(t.totals, true, 0.92);
    }
    if (t.note) {
      p.ensure(14);
      p.text(M, p.y - 10, fit(cur(t.note), W - 2 * M, 7.5), 7.5, false, true);
      p.y -= 14;
    }
  }
  // Footer on every page, once the page count is known.
  const n = p.pages.length;
  p.pages.forEach((ops, i) => {
    ops.push(
      `0.4 0.4 0.4 rg BT /F1 7.5 Tf ${M} 20 Td ${pdfString(`Generated ${r.generatedAt} from the ${r.source} copy. Page ${i + 1} of ${n}.`)} Tj ET`,
    );
  });
  return pdfDocument(p.pages.map((ops) => ops.join("\n")));
}
export function pdfDocument(contents: string[]): Buffer {
  const objects: string[] = [];
  // Object numbers start at 1, so push() returns the new object's number.
  const add = (body: string) => objects.push(body);
  const catalog = add(""),
    pagesId = add(""),
    f1 = add(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ),
    f2 = add(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
  const kids: number[] = [];
  for (const c of contents) {
    const stream = Buffer.from(c, "latin1");
    const content = add(
      `<< /Length ${stream.length} >>\nstream\n${c}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const chunks: Buffer[] = [
    Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"),
  ];
  let offset = chunks[0].length;
  const xref: number[] = [];
  objects.forEach((body, i) => {
    xref.push(offset);
    const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(b);
    offset += b.length;
  });
  const table = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...xref.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>`,
    "startxref",
    String(offset),
    "%%EOF\n",
  ].join("\n");
  chunks.push(Buffer.from(table, "latin1"));
  return Buffer.concat(chunks);
}

// ---------- ZIP ----------
// Deflate, no encryption, no ZIP64 (each export is far below 4 GB).
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const b of data) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zip(
  files: { name: string; data: Buffer }[],
  date = new Date(),
) {
  const time =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1),
    day =
      ((date.getFullYear() - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"),
      packed = deflateRawSync(f.data),
      crc = crc32(f.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(f.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(day, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}
