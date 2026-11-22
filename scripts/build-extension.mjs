import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';

const ROOT = process.cwd();
const DIST = path.resolve(ROOT, 'dist');
const PUBLIC_DIR = path.resolve(ROOT, 'public');

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function run() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 1. Popup UI (HTML + CSS + JS)
  await build({
    configFile: false,
    root: path.resolve(ROOT, 'src/popup'),
    base: './',
    build: {
      outDir: DIST,
      emptyOutDir: false,
      sourcemap: false,
      rollupOptions: {
        input: {
          popup: path.resolve(ROOT, 'src/popup/index.html'),
        },
        output: {
          entryFileNames: 'popup.js',
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: (info) =>
            info.name?.endsWith('.css') ? 'popup.css' : 'assets/[name][extname]',
        },
      },
    },
    logLevel: 'warn',
  });

  // Rename src/popup/index.html output (index.html -> popup.html)
  const builtIndex = path.join(DIST, 'index.html');
  const targetPopup = path.join(DIST, 'popup.html');
  if (fs.existsSync(builtIndex)) {
    fs.renameSync(builtIndex, targetPopup);
  }

  // 2. MAIN world page-bridge script (self-contained IIFE)
  await build({
    configFile: false,
    root: ROOT,
    build: {
      outDir: DIST,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: path.resolve(ROOT, 'src/content/page-bridge.ts'),
        name: 'BetterSubtitlePageBridge',
        formats: ['iife'],
        fileName: () => 'page-bridge.js',
      },
    },
    logLevel: 'warn',
  });

  // 3. ISOLATED world content script (self-contained IIFE)
  await build({
    configFile: false,
    root: ROOT,
    build: {
      outDir: DIST,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: path.resolve(ROOT, 'src/content/index.ts'),
        name: 'BetterSubtitleContent',
        formats: ['iife'],
        fileName: () => 'content.js',
      },
    },
    logLevel: 'warn',
  });

  // 4. MV3 Background Service Worker (ES module)
  await build({
    configFile: false,
    root: ROOT,
    build: {
      outDir: DIST,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: path.resolve(ROOT, 'src/background/service-worker.ts'),
        formats: ['es'],
        fileName: () => 'service-worker.js',
      },
    },
    logLevel: 'warn',
  });

  // 5. Copy manifest.json and icons
  copyDirRecursive(PUBLIC_DIR, DIST);

  console.log('BetterSubtitle extension built successfully to dist/');
}

run().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
