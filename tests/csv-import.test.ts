import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  readImport,
  templateCsv,
  importKinds,
  MAX_IMPORT_ROWS,
} from "../packages/core/src/csv-import.js";

test("CSV parsing handles quotes, line breaks, BOM and CRLF", () => {
  assert.deepEqual(
    parseCsv('﻿name,notes\r\n"Okafor, Ada","Said ""hi""\nthen left"\r\n\r\n'),
    [
      ["name", "notes"],
      ["Okafor, Ada", 'Said "hi"\nthen left'],
    ],
  );
  assert.throws(() => parseCsv('a\n"open'), /not closed/);
});

test("semicolon and tab separated files are detected", () => {
  assert.deepEqual(parseCsv("a;b\n1;2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("rooms read with header aliases, amounts and defaults", () => {
  const r = readImport(
    "rooms",
    'Room No,Type,Level,Nightly Rate\n101,Deluxe,1,"₦55,000"\n102,Deluxe,,\n',
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0].value, {
    roomNumber: "101",
    roomType: "Deluxe",
    floor: 1,
    rate: "55000.00",
    capacity: null,
  });
  assert.equal(r.rows[1].value.floor, 0);
});

test("row errors carry spreadsheet row numbers", () => {
  const r = readImport(
    "rooms",
    "room_number,room_type,floor,rate\n101,Deluxe,1,abc\n,Deluxe,1,\n103,Deluxe,999,\n104,Deluxe,1,\n104,Suite,2,\n",
  );
  assert.deepEqual(
    r.errors.map((e) => e.row),
    [2, 3, 4, 6],
  );
  assert.match(r.errors[3].message, /Duplicate of row 5/);
});

test("a missing required column is reported once, at the header", () => {
  const r = readImport("menu", "name,price\nTea,500\n");
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /Missing column: department/);
});

test("menu items and guests validate their fields", () => {
  const m = readImport(
    "menu",
    "category,item,price,unit\nRoom Service,Club sandwich,6500,\nBar,X,1,\n",
  );
  assert.deepEqual(m.rows[0].value, {
    department: "room_service",
    name: "Club sandwich",
    price: "6500.00",
    unit: "each",
  });
  assert.match(m.errors[0].message, /2 to 100/);
  const g = readImport(
    "guests",
    "Name,Email,Phone\nAda Okafor,ADA@Example.com,0801\nBola,not-an-email,\n",
  );
  assert.deepEqual(g.rows[0].value, {
    fullName: "Ada Okafor",
    email: "ada@example.com",
    phone: "0801",
  });
  assert.match(g.errors[0].message, /not an email/);
});

test("templates read back cleanly and large files are refused", () => {
  for (const kind of importKinds)
    assert.deepEqual(readImport(kind, templateCsv(kind)).errors, [], kind);
  const big =
    "full_name\n" +
    Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Guest ${i}`).join(
      "\n",
    );
  assert.match(readImport("guests", big).errors[0].message, /at most/);
});
