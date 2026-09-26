/**
 * Dependency-free PNG icon generator.
 *
 * Chrome/Edge require raster toolbar icons, so instead of shipping binary blobs
 * in the repo we synthesise the ROSE rose-gradient badge at build time using
 * Node's zlib for the DEFLATE stream. Keeps the repository text-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Renders the rose badge: violet→rose gradient squircle with a cyan petal core. */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const VIOLET = [124, 58, 237];
  const ROSE = [236, 72, 153];
  const CYAN = [34, 211, 238];
  const radius = size * 0.26;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // Rounded-square mask with 4px-equivalent antialiasing.
      const dx = Math.max(radius - cx, cx - (size - radius), 0);
      const dy = Math.max(radius - cy, cy - (size - radius), 0);
      const dist = Math.hypot(dx, dy);
      const edge = Math.max(0, Math.min(1, radius - dist + 0.5));

      const t = (cx / size + cy / size) / 2;
      let [r, g, b] = mix(VIOLET, ROSE, t);

      // Cyan petal core.
      const coreR = size * 0.2;
      const coreDist = Math.hypot(cx - size / 2, cy - size * 0.46);
      const core = Math.max(0, 1 - coreDist / coreR);
      if (core > 0) [r, g, b] = mix([r, g, b], CYAN, core * 0.85);

      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(255 * edge);
    }
  }
  return encodePng(size, size, rgba);
}

export function generateIcons(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(outDir, `icon${size}.png`), renderIcon(size));
  }
  return [16, 32, 48, 128];
}

// Allow standalone invocation: `node scripts/gen-icons.mjs public/icons`
if (process.argv[1] && process.argv[1].endsWith('gen-icons.mjs')) {
  const target = process.argv[2] || path.resolve('public/icons');
  generateIcons(target);
  process.stdout.write(`icons written to ${target}\n`);
}
