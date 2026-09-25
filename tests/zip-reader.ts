import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { crc32 } from "../packages/core/src/report-format.js";
// Minimal reader for the exports this project writes: central directory, deflate, CRC check.
export function unzip(buf: Buffer) {
  const files = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20),
      crc = buf.readUInt32LE(p + 16),
      nameLen = buf.readUInt16LE(p + 28),
      offset = buf.readUInt32LE(p + 42),
      name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localName =
      buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = inflateRawSync(
      buf.subarray(offset + 30 + localName, offset + 30 + localName + size),
    );
    assert.equal(crc32(data), crc, `${name} checksum`);
    files.set(name, data);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}
