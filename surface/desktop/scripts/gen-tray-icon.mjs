// Generates the macOS/Windows tray template icon (a filled ring "Atrium" mark)
// as PNGs, with no image dependency. Run: node scripts/gen-tray-icon.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'resources');
mkdirSync(outDir, { recursive: true });

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const channels = 4;
  const stride = size * channels + 1; // +1 filter byte per row
  const raw = Buffer.alloc(stride * size);
  const c = (size - 1) / 2;
  const rOuter = size / 2 - 0.5;
  const rInner = rOuter * 0.52; // ring hole
  const cov = (d, edge) => {
    // antialiased coverage around a radius `edge`
    if (d <= edge - 0.5) return 1;
    if (d >= edge + 0.5) return 0;
    return edge + 0.5 - d;
  };
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = Math.min(cov(d, rOuter), 1 - cov(d, rInner));
      const a = Math.max(0, Math.min(1, ring));
      const off = y * stride + 1 + x * channels;
      raw[off] = 0;
      raw[off + 1] = 0;
      raw[off + 2] = 0;
      raw[off + 3] = Math.round(a * 255); // black + alpha → template image
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(join(outDir, 'trayTemplate.png'), makePng(16));
writeFileSync(join(outDir, 'trayTemplate@2x.png'), makePng(32));
console.log('wrote resources/trayTemplate.png (16) + @2x (32)');
