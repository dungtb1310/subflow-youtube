import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.resolve(process.cwd(), 'public', 'icons');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function blendOver(dst, r, g, b, a) {
  const alpha = Math.max(0, Math.min(1, a));
  const inv = 1 - alpha;
  return [
    dst[0] * inv + r * alpha,
    dst[1] * inv + g * alpha,
    dst[2] * inv + b * alpha,
    Math.min(1, dst[3] + alpha * (1 - dst[3])),
  ];
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1.15 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // Rounded obsidian container
      const bgDist = sdRoundedBox(u, v, 0.5, 0.5, 0.46, 0.46, 0.2);
      const bgAlpha = Math.max(0, Math.min(1, 0.5 - bgDist / aa));

      let pixel = [0, 0, 0, 0];
      if (bgAlpha > 0) {
        // Subtle vertical depth from #161A22 at top to #0D1016 at bottom
        const t = Math.max(0, Math.min(1, (v - 0.04) / 0.92));
        const br = 22 * (1 - t) + 13 * t;
        const bg = 26 * (1 - t) + 16 * t;
        const bb = 34 * (1 - t) + 22 * t;
        pixel = [br, bg, bb, bgAlpha];

        // Subtle inner rim highlight (1px equivalent)
        const innerRim = Math.abs(bgDist + 0.025) - 0.012;
        const rimAlpha = Math.max(0, Math.min(1, 0.5 - innerRim / aa)) * 0.14 * bgAlpha;
        if (rimAlpha > 0) {
          pixel = blendOver(pixel, 255, 255, 255, rimAlpha);
        }

        // Top-left cinema play indicator triangle / flow dot (amber-gold)
        const dotDist = Math.hypot(u - 0.25, v - 0.29) - 0.058;
        const dotAlpha = Math.max(0, Math.min(1, 0.5 - dotDist / aa)) * bgAlpha;
        if (dotAlpha > 0) {
          pixel = blendOver(pixel, 245, 185, 66, dotAlpha);
        }

        // Top short accent bar next to dot (represents sentence flow)
        const topBarDist = sdRoundedBox(u, v, 0.57, 0.29, 0.20, 0.045, 0.045);
        const topBarAlpha = Math.max(0, Math.min(1, 0.5 - topBarDist / aa)) * bgAlpha * 0.4;
        if (topBarAlpha > 0) {
          pixel = blendOver(pixel, 154, 163, 181, topBarAlpha);
        }

        // Primary subtitle bar (clean warm amber-gold sentence line)
        const line1Dist = sdRoundedBox(u, v, 0.5, 0.54, 0.31, 0.062, 0.062);
        const line1Alpha = Math.max(0, Math.min(1, 0.5 - line1Dist / aa)) * bgAlpha;
        if (line1Alpha > 0) {
          pixel = blendOver(pixel, 245, 185, 66, line1Alpha);
        }

        // Secondary dual-subtitle bar (crisp off-white sentence line)
        const line2Dist = sdRoundedBox(u, v, 0.43, 0.72, 0.24, 0.056, 0.056);
        const line2Alpha = Math.max(0, Math.min(1, 0.5 - line2Dist / aa)) * bgAlpha;
        if (line2Alpha > 0) {
          pixel = blendOver(pixel, 242, 244, 248, line2Alpha);
        }
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(pixel[0]);
      rgba[idx + 1] = Math.round(pixel[1]);
      rgba[idx + 2] = Math.round(pixel[2]);
      rgba[idx + 3] = Math.round(pixel[3] * 255);
    }
  }

  return encodePNG(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const outPath = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, renderIcon(size));
  console.log(`Generated ${outPath}`);
}
