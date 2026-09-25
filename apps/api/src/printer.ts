import {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
} from "node-thermal-printer";
import { SerialPort } from "serialport";
import { z } from "zod";
import net from "node:net";
import {
  readFile,
  stat,
  open,
  mkdtemp,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReceiptSnapshot } from "./billing-service.js";
const privateIp = (s: string) => {
  if (net.isIP(s) !== 4) return false;
  const n = s.split(".").map(Number);
  return (
    n[0] === 10 ||
    (n[0] === 192 && n[1] === 168) ||
    (n[0] === 172 && n[1] >= 16 && n[1] <= 31)
  );
};
export const printerSchema = z
  .object({
    type: z.enum(["network", "usb", "serial"]),
    interface: z.string().trim().min(1).max(150),
    width: z.enum(["58", "80"]),
    characterSet: z.nativeEnum(CharacterSet),
    baudRate: z
      .number()
      .int()
      .refine((v) => [9600, 19200, 38400, 57600, 115200].includes(v))
      .default(9600),
    cut: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === "network") {
      const match = /^tcp:\/\/([\d.]+):(\d+)$/.exec(v.interface);
      if (
        !match ||
        !privateIp(match[1]) ||
        Number(match[2]) < 1 ||
        Number(match[2]) > 65535
      )
        ctx.addIssue({
          code: "custom",
          message: "Use tcp://PRIVATE_LAN_IP:9100",
          path: ["interface"],
        });
    } else if (
      v.type === "serial" &&
      !/^(COM\d+|\/dev\/tty(?:USB|ACM|S)\d+)$/.test(v.interface)
    )
      ctx.addIssue({
        code: "custom",
        message: "Use COM3 or /dev/ttyUSB0",
        path: ["interface"],
      });
    else if (
      v.type === "usb" &&
      !/^(printer:[^\x00-\x1f]{1,100}|\/dev\/usb\/lp\d+)$/.test(v.interface)
    )
      ctx.addIssue({
        code: "custom",
        message: "Use printer:Windows queue name or /dev/usb/lp0",
        path: ["interface"],
      });
  });
export type PrinterConfig = z.infer<typeof printerSchema>;
const safe = (s: string) =>
  s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1000);
export async function thermalBytes(
  snapshot: ReceiptSnapshot,
  config: PrinterConfig,
  reprint = false,
) {
  const p = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface:
      config.type === "network" ? config.interface : "printer:HotelHub",
    width: config.width === "58" ? 32 : 48,
    characterSet: config.characterSet,
    removeSpecialCharacters: false,
  });
  p.alignCenter();
  if (snapshot.hotel.logoUrl) {
    const root = await realpath(resolve("apps/web/public/assets"));
    const path = await realpath(
      resolve("apps/web/public", snapshot.hotel.logoUrl.replace(/^\//, "")),
    );
    if (!path.startsWith(root + sep))
      throw new Error("Logo must stay inside public/assets.");
    const meta = await stat(path);
    if (meta.size > 1024 * 1024) throw new Error("Logo exceeds 1 MB.");
    const png = await readFile(path);
    if (
      png.length < 24 ||
      png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      png.readUInt32BE(16) > (config.width === "58" ? 384 : 576) ||
      png.readUInt32BE(20) > 384
    )
      throw new Error(
        "Use a small PNG logo within the paper width and 384 pixels high.",
      );
    await p.printImageBuffer(png);
  }
  p.bold(true);
  p.println(safe(snapshot.hotel.name));
  p.bold(false);
  p.println(safe(snapshot.hotel.address));
  p.println(snapshot.kind === "refund" ? "REFUND RECEIPT" : "PAYMENT RECEIPT");
  if (reprint) p.println("COPY / REPRINT");
  p.println(safe(snapshot.number));
  p.println(safe(snapshot.issuedAt));
  p.alignLeft();
  p.println("Cashier: " + safe(snapshot.cashier));
  p.println("Guest: " + safe(snapshot.customer));
  p.drawLine();
  for (const line of snapshot.lines) {
    p.println(safe(line.description));
    p.leftRight("", `${snapshot.hotel.currency} ${line.amount}`);
  }
  p.drawLine();
  p.leftRight("Bill total", snapshot.total);
  p.leftRight(
    snapshot.kind === "refund" ? "Refunded" : "Paid this receipt",
    snapshot.paid,
  );
  p.leftRight("Balance", snapshot.balance);
  for (const payment of snapshot.payments) {
    p.println(
      safe(`${payment.method}: ${payment.amount} ${payment.reference ?? ""}`),
    );
  }
  p.drawLine();
  p.alignCenter();
  p.println(safe(snapshot.hotel.footer));
  if (snapshot.hotel.providerCredit) p.println("Powered by Hotel Hub");
  p.newLine();
  if (config.cut) p.cut();
  return p.getBuffer();
}
export async function sendBytes(bytes: Buffer, config: PrinterConfig) {
  if (config.type === "network") {
    const url = new URL(config.interface);
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(
        { host: url.hostname, port: Number(url.port) },
        () => socket.end(bytes),
      );
      socket.setTimeout(5000, () =>
        socket.destroy(new Error("Printer send timeout.")),
      );
      socket.once("error", reject);
      socket.once("finish", () => {
        socket.destroy();
        resolve();
      });
    });
    return;
  }
  if (config.type === "serial") {
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({
        path: config.interface,
        baudRate: config.baudRate,
        autoOpen: false,
      });
      let done = false;
      const finish = (err?: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (port.isOpen) port.close(() => {});
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("Serial printer timeout.")),
        5000,
      );
      port.on("error", finish);
      port.open((err) => {
        if (err) return finish(err);
        port.write(bytes, (err) => {
          if (err) return finish(err);
          port.drain(finish);
        });
      });
    });
    return;
  }
  if (process.platform === "win32") {
    if (!config.interface.startsWith("printer:"))
      throw new Error("Windows USB requires printer:Queue name.");
    const dir = await mkdtemp(resolve(tmpdir(), "hotel-print-"));
    try {
      const file = resolve(dir, "receipt.bin");
      await writeFile(file, bytes);
      await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          resolve("deploy/windows/print-raw.ps1"),
          "-PrinterName",
          config.interface.slice(8),
          "-FilePath",
          file,
        ],
        { timeout: 10000, windowsHide: true },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }
  if (
    !/^\/dev\/usb\/lp\d+$/.test(config.interface) ||
    (await stat(config.interface)).isCharacterDevice() !== true
  )
    throw new Error("Linux USB requires a printer character device.");
  const file = await open(config.interface, "w");
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}
