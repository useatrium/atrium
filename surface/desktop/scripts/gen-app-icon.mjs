// Generates the macOS app icon (build/icon.png, 1024²) with no image deps:
// an indigo rounded-rect ("squircle"-ish) with the white Atrium ring mark.
// electron-builder converts this PNG into the .icns at package time.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });

const S = 1024;
const cx = S / 2;
const cy = S / 2;
const margin = S * 0.092; // macOS icons sit in a ~82% safe area
const halfW = (S - 2 * margin) / 2;
const radius = (S - 2 * margin) * 0.2237; // Apple continuous-corner ratio
const ringOuter = S * 0.3;
const ringInner = ringOuter * 0.62;
const top = [129, 140, 248]; // indigo-400
const bot = [79, 70, 229]; // indigo-600

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const aa = (d) => clamp01(0.5 - d); // coverage from a signed distance (neg = inside)

function roundedRectSDF(px, py) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfW - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

const channels = 4;
const stride = S * channels + 1;
const raw = Buffer.alloc(stride * S);
for (let y = 0; y < S; y++) {
  raw[y * stride] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const rectCov = aa(roundedRectSDF(px, py));

    const t = clamp01((py - margin) / (S - 2 * margin));
    let r = top[0] + (bot[0] - top[0]) * t;
    let g = top[1] + (bot[1] - top[1]) * t;
    let b = top[2] + (bot[2] - top[2]) * t;

    const dC = Math.hypot(px - cx, py - cy);
    const ring = clamp01(Math.min(aa(dC - ringOuter), 1 - aa(dC - ringInner)));
    r += (255 - r) * ring;
    g += (255 - g) * ring;
    b += (255 - b) * ring;

    const off = y * stride + 1 + x * channels;
    raw[off] = Math.round(r);
    raw[off + 1] = Math.round(g);
    raw[off + 2] = Math.round(b);
    raw[off + 3] = Math.round(rectCov * 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
writeFileSync(
  out,
  Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
);
console.log('wrote', out);
