// CSV import for hotel set-up data: rooms, menu items and guests. Parsing and row checks
// live here, without dependencies, so the hub and tests share them.
export const importKinds = ["rooms", "menu", "guests"] as const;
export type ImportKind = (typeof importKinds)[number];
export const MAX_IMPORT_ROWS = 1000;

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. Accepts a
// UTF-8 byte order mark, CRLF or LF, and comma, semicolon or tab separators (spreadsheets
// in many locales save with semicolons).
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map(
    (d) => [d, countOutsideQuotes(firstLine, d)] as const,
  );
  const delimiter = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && src[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new Error("A quoted value is not closed.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}
function countOutsideQuotes(line: string, d: string) {
  let n = 0,
    q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

type Column = {
  key: string;
  aliases: string[];
  required?: boolean;
  hint: string;
};
export const importColumns: Record<ImportKind, Column[]> = {
  rooms: [
    {
      key: "room_number",
      aliases: ["room", "room_no", "number", "room_#"],
      required: true,
      hint: "101",
    },
    {
      key: "room_type",
      aliases: ["type", "category", "room_category"],
      required: true,
      hint: "Deluxe",
    },
    { key: "floor", aliases: ["level"], hint: "1" },
    {
      key: "rate",
      aliases: ["nightly_rate", "price", "base_rate"],
      hint: "55000",
    },
    {
      key: "capacity",
      aliases: ["guests", "max_guests", "occupancy"],
      hint: "2",
    },
  ],
  menu: [
    {
      key: "department",
      aliases: ["category", "section"],
      required: true,
      hint: "restaurant",
    },
    {
      key: "name",
      aliases: ["item", "item_name", "product"],
      required: true,
      hint: "Jollof rice",
    },
    {
      key: "price",
      aliases: ["amount", "cost", "selling_price"],
      required: true,
      hint: "4500",
    },
    { key: "unit", aliases: ["uom", "measure"], hint: "plate" },
  ],
  guests: [
    {
      key: "full_name",
      aliases: ["name", "guest", "guest_name"],
      required: true,
      hint: "Ada Okafor",
    },
    {
      key: "phone",
      aliases: ["phone_number", "mobile", "telephone"],
      hint: "+234 801 234 5678",
    },
    {
      key: "email",
      aliases: ["email_address", "e-mail"],
      hint: "ada@example.com",
    },
    { key: "nationality", aliases: ["country"], hint: "Nigerian" },
    { key: "address", aliases: [], hint: "12 Marina Road, Lagos" },
    {
      key: "id_type",
      aliases: ["document_type", "id_document"],
      hint: "Passport",
    },
    {
      key: "id_number",
      aliases: ["document_number", "passport_number"],
      hint: "A12345678",
    },
    {
      key: "notes",
      aliases: ["remarks", "comment"],
      hint: "Prefers a quiet room",
    },
  ],
};
export function templateCsv(kind: ImportKind) {
  const cols = importColumns[kind];
  return (
    cols.map((c) => c.key).join(",") +
    "\n" +
    cols
      .map((c) =>
        /[,"\n]/.test(c.hint) ? `"${c.hint.replace(/"/g, '""')}"` : c.hint,
      )
      .join(",") +
    "\n"
  );
}
const normal = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "_")
    .replace(/[()]/g, "");

export type RoomRow = {
  roomNumber: string;
  roomType: string;
  floor: number;
  rate: string | null;
  capacity: number | null;
};
export type MenuRow = {
  department: string;
  name: string;
  price: string;
  unit: string;
};
export type GuestRow = {
  fullName: string;
  phone?: string;
  email?: string;
  nationality?: string;
  address?: string;
  idType?: string;
  idNumber?: string;
  notes?: string;
};
export type RowError = { row: number; message: string };
type Parsed<T> = { rows: { row: number; value: T }[]; errors: RowError[] };

// Money in the hotel's currency: "55,000", "₦55000.5" and "55000.50" all read as 55000.50.
function money(v: string) {
  const s = v.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s).toFixed(2);
}
function int(v: string, min: number, max: number) {
  if (!/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Maps headers, checks every row and reports problems by spreadsheet row number (the
// header is row 1), so a hotel can fix its file and upload it again.
export function readImport(kind: "rooms", text: string): Parsed<RoomRow>;
export function readImport(kind: "menu", text: string): Parsed<MenuRow>;
export function readImport(kind: "guests", text: string): Parsed<GuestRow>;
export function readImport(kind: ImportKind, text: string): Parsed<unknown>;
export function readImport(kind: ImportKind, text: string): Parsed<unknown> {
  const table = parseCsv(text);
  if (table.length === 0)
    return { rows: [], errors: [{ row: 1, message: "The file is empty." }] };
  const cols = importColumns[kind];
  const header = table[0].map(normal);
  const index: Record<string, number> = {};
  for (const c of cols) {
    const at = header.findIndex((h) => h === c.key || c.aliases.includes(h));
    if (at >= 0) index[c.key] = at;
  }
  const missing = cols.filter((c) => c.required && index[c.key] === undefined);
  if (missing.length)
    return {
      rows: [],
      errors: [
        {
          row: 1,
          message: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.map((c) => c.key).join(", ")}. Download the template to see the expected headings.`,
        },
      ],
    };
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS)
    return {
      rows: [],
      errors: [
        { row: 1, message: `Import at most ${MAX_IMPORT_ROWS} rows per file.` },
      ],
    };
  const rows: { row: number; value: unknown }[] = [];
  const errors: RowError[] = [];
  body.forEach((cells, i) => {
    const row = i + 2;
    const get = (k: string) =>
      index[k] === undefined ? "" : (cells[index[k]] ?? "").trim();
    const fail = (message: string) => errors.push({ row, message });
    if (kind === "rooms") {
      const roomNumber = get("room_number"),
        roomType = get("room_type");
      if (!roomNumber) return fail("Room number is empty.");
      if (roomNumber.length > 20)
        return fail("Room number is longer than 20 characters.");
      if (roomType.length < 2 || roomType.length > 100)
        return fail("Room type needs 2 to 100 characters.");
      const floor = get("floor") === "" ? 0 : int(get("floor"), -5, 150);
      if (floor === null)
        return fail("Floor must be a whole number from -5 to 150.");
      const rate = get("rate") === "" ? null : money(get("rate"));
      if (get("rate") !== "" && rate === null)
        return fail(`Rate "${get("rate")}" is not an amount.`);
      const capacity =
        get("capacity") === "" ? null : int(get("capacity"), 1, 20);
      if (get("capacity") !== "" && capacity === null)
        return fail("Capacity must be a whole number from 1 to 20.");
      rows.push({
        row,
        value: {
          roomNumber,
          roomType,
          floor,
          rate,
          capacity,
        } satisfies RoomRow,
      });
    } else if (kind === "menu") {
      const department = get("department").toLowerCase().replace(/\s+/g, "_"),
        name = get("name");
      if (!department) return fail("Department is empty.");
      if (name.length < 2 || name.length > 100)
        return fail("Name needs 2 to 100 characters.");
      const price = money(get("price"));
      if (price === null)
        return fail(`Price "${get("price")}" is not an amount.`);
      const unit = get("unit") || "each";
      if (unit.length > 30) return fail("Unit is longer than 30 characters.");
      rows.push({
        row,
        value: { department, name, price, unit } satisfies MenuRow,
      });
    } else {
      const fullName = get("full_name");
      if (fullName.length < 2 || fullName.length > 150)
        return fail("Full name needs 2 to 150 characters.");
      const email = get("email");
      if (email && (!EMAIL.test(email) || email.length > 254))
        return fail(`"${email}" is not an email address.`);
      const limits: [keyof GuestRow, string, number][] = [
        ["phone", "phone", 40],
        ["nationality", "nationality", 80],
        ["address", "address", 500],
        ["idType", "id_type", 50],
        ["idNumber", "id_number", 100],
        ["notes", "notes", 2000],
      ];
      const value: GuestRow = { fullName };
      if (email) value.email = email.toLowerCase();
      for (const [field, column, max] of limits) {
        const v = get(column);
        if (v.length > max)
          return fail(`${column} is longer than ${max} characters.`);
        if (v) value[field] = v;
      }
      rows.push({ row, value });
    }
  });
  // Duplicates inside the file itself.
  const key = (v: any) =>
    kind === "rooms"
      ? String(v.roomNumber).toLowerCase()
      : kind === "menu"
        ? `${v.department}|${String(v.name).toLowerCase()}`
        : null;
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = key(r.value);
    if (k === null) continue;
    if (seen.has(k))
      errors.push({ row: r.row, message: `Duplicate of row ${seen.get(k)}.` });
    else seen.set(k, r.row);
  }
  errors.sort((a, b) => a.row - b.row);
  return { rows, errors };
}
