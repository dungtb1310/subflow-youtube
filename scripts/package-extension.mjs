import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const DIST = path.resolve(ROOT, 'dist');
const RELEASE_DIR = path.resolve(ROOT, 'release');

const REQUIRED_FILES = [
  'manifest.json',
  'content.js',
  'live-overlay.js',
  'page-bridge.js',
  'service-worker.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

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

function collectFiles(dir, base = '') {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${item.name}` : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...collectFiles(full, rel));
    } else {
      entries.push({ rel, full });
    }
  }
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

function toDosTimeDate(date) {
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const { dosTime, dosDate } = toDosTimeDate(now);

  for (const file of files) {
    const nameBuf = Buffer.from(file.rel, 'utf8');
    const rawData = fs.readFileSync(file.full);
    const compressed = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = compressed.length < rawData.length;
    const payload = useDeflate ? compressed : rawData;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(rawData);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function main() {
  if (!fs.existsSync(DIST)) {
    throw new Error('dist/ directory not found. Run "npm run build" first.');
  }

  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(DIST, rel))) {
      throw new Error(`Missing required extension file in dist/: ${rel}`);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const tagArg = process.argv[2]?.trim();
  const versionLabel = tagArg
    ? tagArg.startsWith('v')
      ? tagArg
      : `v${tagArg}`
    : `v${manifest.version || '1.0.0'}`;

  const files = collectFiles(DIST);
  const zipBuf = createZipBuffer(files);

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const zipName = `BetterSubtitle-${versionLabel}.zip`;
  const zipPath = path.join(RELEASE_DIR, zipName);
  fs.writeFileSync(zipPath, zipBuf);

  const sha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');
  fs.writeFileSync(path.join(RELEASE_DIR, 'SHA256SUMS.txt'), `${sha256}  ${zipName}\n`, 'utf8');

  console.log(`Packaged ${zipPath} (${(zipBuf.length / 1024).toFixed(1)} KB, ${files.length} files)`);
  console.log(`SHA256: ${sha256}`);
}

main();
