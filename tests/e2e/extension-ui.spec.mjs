import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = path.resolve(ROOT, 'dist');
const SCREENSHOT_DIR = process.env.SUBFLOW_E2E_SCREENSHOTS || '';

function findChromiumExecutable() {
  // Prefer Edge/Chromium first because branded Google Chrome 137+ disables --load-extension CLI flag
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No Chromium/Edge executable found. Set CHROME_PATH env variable.');
}

const SAMPLE_WORD_BY_WORD_JSON3 = {
  events: [
    { tStartMs: 200, dDurationMs: 100, aAppend: 1, segs: [{ utf8: '\n' }] },
    {
      tStartMs: 500,
      dDurationMs: 5200,
      segs: [
        { utf8: 'youtube' },
        { utf8: ' auto', tOffsetMs: 320 },
        { utf8: ' captions', tOffsetMs: 650 },
        { utf8: ' scroll', tOffsetMs: 1020 },
        { utf8: ' word', tOffsetMs: 1380 },
        { utf8: ' by', tOffsetMs: 1650 },
        { utf8: ' word', tOffsetMs: 1880 },
        { utf8: ' and', tOffsetMs: 2180 },
        { utf8: ' break', tOffsetMs: 2450 },
        { utf8: ' every', tOffsetMs: 2780 },
        { utf8: ' sentence', tOffsetMs: 3120 },
      ],
    },
    {
      tStartMs: 4900,
      dDurationMs: 4500,
      segs: [
        { utf8: 'subflow' },
        { utf8: ' merges', tOffsetMs: 360 },
        { utf8: ' them', tOffsetMs: 700 },
        { utf8: ' cleanly', tOffsetMs: 1040 },
        { utf8: ' into', tOffsetMs: 1400 },
        { utf8: ' real', tOffsetMs: 1680 },
        { utf8: ' readable', tOffsetMs: 2020 },
        { utf8: ' lines', tOffsetMs: 2450 },
      ],
    },
  ],
};

const YOUTUBE_HARNESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Building Better Subtitles — SubFlow Demo - YouTube</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0f0f0f;
      color: #f1f1f1;
      font-family: Roboto, "Segoe UI", Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;
    }
    .html5-video-player {
      position: relative;
      width: 960px;
      height: 540px;
      border-radius: 12px;
      overflow: hidden;
      background:
        radial-gradient(circle at 28% 35%, #23334e 0%, #101520 55%, #090c12 100%);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    }
    video.html5-main-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .scene-card {
      position: absolute;
      top: 42px;
      left: 48px;
      color: rgba(255, 255, 255, 0.85);
      pointer-events: none;
    }
    .scene-card h2 {
      margin: 0 0 6px;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .scene-card p {
      margin: 0;
      font-size: 14px;
      color: rgba(210, 220, 238, 0.72);
    }
    .ytp-caption-window-container {
      position: absolute;
      left: 50%;
      bottom: 84px;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      padding: 4px 10px;
      font-size: 18px;
      z-index: 20;
    }
    .ytp-chrome-bottom {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 48px;
      padding: 0 14px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.82));
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 30;
    }
    .ytp-left-controls {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.9);
    }
    .ytp-right-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .ytp-button {
      width: 44px;
      height: 44px;
      background: transparent;
      border: none;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
    }
  </style>
  <script>
    window.ytInitialPlayerResponse = {
      videoDetails: {
        videoId: 'subflowDemo1',
        title: 'Building Better Subtitles — SubFlow Demo'
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              languageCode: 'en',
              name: { simpleText: 'English (auto-generated)' },
              baseUrl: 'https://www.youtube.com/api/timedtext?v=subflowDemo1&lang=en',
              kind: 'asr',
              isTranslatable: true
            }
          ]
        }
      }
    };
  </script>
</head>
<body>
  <div id="movie_player" class="html5-video-player">
    <video class="html5-main-video" muted></video>
    <div class="scene-card">
      <h2>Building Better Subtitles — SubFlow Demo</h2>
      <p>Live extension harness · word-by-word ASR converted to sentence-level cues</p>
    </div>
    <div class="ytp-caption-window-container">youtube auto captions scroll...</div>
    <div class="ytp-chrome-bottom">
      <div class="ytp-left-controls">0:01 / 0:10</div>
      <div class="ytp-right-controls">
        <button class="ytp-button ytp-subtitles-button" title="Subtitles/closed captions">CC</button>
        <button class="ytp-button" title="Settings">HD</button>
      </div>
    </div>
  </div>
  <script>
    const player = document.getElementById('movie_player');
    player.getPlayerResponse = () => window.ytInitialPlayerResponse;

    // Attach a real 12-second silent WAV stream to <video> so video.currentTime
    // works natively across both MAIN world and Chrome's ISOLATED content-script world.
    function createSilentWavBlobUrl(durationSec) {
      const sampleRate = 8000;
      const numSamples = sampleRate * durationSec;
      const buffer = new ArrayBuffer(44 + numSamples);
      const view = new DataView(buffer);
      const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + numSamples, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate, true);
      view.setUint16(32, 1, true);
      view.setUint16(34, 8, true);
      writeStr(36, 'data');
      view.setUint32(40, numSamples, true);
      new Uint8Array(buffer, 44).fill(128);
      return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    }

    const video = player.querySelector('video');
    video.src = createSilentWavBlobUrl(12);
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = 1.6;
    });
    window.__setDemoTime = (sec) => {
      video.currentTime = sec;
      video.dispatchEvent(new Event('timeupdate'));
      video.dispatchEvent(new Event('seeked'));
    };
  </script>
</body>
</html>`;

async function run() {
  assert.ok(fs.existsSync(path.join(DIST, 'manifest.json')), 'dist/manifest.json must exist. Run npm run build first.');
  const executablePath = findChromiumExecutable();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subflow-e2e-'));

  if (SCREENSHOT_DIR) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
      viewport: { width: 1120, height: 740 },
    });

    // 1. Wait for MV3 Service Worker & extract extensionId
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const swUrl = serviceWorker.url();
    const extIdMatch = swUrl.match(/^chrome-extension:\/\/([a-z0-9]+)\//i);
    assert.ok(extIdMatch, `Failed to extract extension ID from ${swUrl}`);
    const extensionId = extIdMatch[1];
    console.log(`[E2E] Loaded SubFlow MV3 extension: ${extensionId}`);

    // 2. Test Popup UI thoroughly
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 400, height: 640 });
    const popupErrors = [];
    popupPage.on('pageerror', (e) => popupErrors.push(e.message));
    popupPage.on('console', (m) => {
      if (m.type() === 'error') popupErrors.push(m.text());
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForSelector('#master-toggle');

    // Verify defaults
    assert.equal(await popupPage.getAttribute('#master-toggle', 'aria-checked'), 'true');
    assert.equal(await popupPage.getAttribute('[data-mode="original"]', 'aria-pressed'), 'true');
    assert.equal(await popupPage.isDisabled('#target-language'), true);

    if (SCREENSHOT_DIR) {
      await popupPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-subtitles.png') });
    }

    // Switch to Dual -> target language unlocks & offline notice appears
    await popupPage.click('[data-mode="dual"]');
    assert.equal(await popupPage.getAttribute('[data-mode="dual"]', 'aria-pressed'), 'true');
    assert.equal(await popupPage.isDisabled('#target-language'), false);
    assert.equal(await popupPage.isVisible('#offline-translate-notice'), true);

    // Click "Configure AI" link inside notice -> switches to AI tab
    await popupPage.click('#jump-ai-btn');
    assert.equal(await popupPage.getAttribute('#tab-ai', 'aria-selected'), 'true');
    assert.equal(await popupPage.isVisible('#panel-ai'), true);

    // Test Gemini provider controls & secret toggle
    await popupPage.click('[data-provider="gemini"]');
    assert.equal(await popupPage.isVisible('#config-gemini'), true);
    await popupPage.fill('#gemini-api-key', 'demo-key-123');
    assert.equal(await popupPage.getAttribute('#gemini-api-key', 'type'), 'password');
    await popupPage.click('[data-toggle-secret="gemini-api-key"]');
    assert.equal(await popupPage.getAttribute('#gemini-api-key', 'type'), 'text');
    await popupPage.selectOption('#gemini-model-preset', 'gemini-4-hydrogen');
    await popupPage.waitForTimeout(180);
    // Verify the debounced API key was NOT clobbered by selecting a model
    assert.equal(await popupPage.inputValue('#gemini-api-key'), 'demo-key-123');

    if (SCREENSHOT_DIR) {
      await popupPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-ai.png') });
    }

    // Test OpenAI preset chip
    await popupPage.click('[data-provider="openai"]');
    await popupPage.click('button.chip-btn:has-text("Groq")');
    assert.equal(await popupPage.inputValue('#openai-base-url'), 'https://api.groq.com/openai/v1');
    assert.equal(await popupPage.inputValue('#openai-model'), 'llama-3.3-70b-versatile');

    // Switch back to Offline & click Test Connection (real MV3 background round-trip)
    await popupPage.click('[data-provider="offline"]');
    await popupPage.click('#test-connection-btn');
    await popupPage.waitForSelector('#connection-result.ok', { timeout: 5000 });
    const feedbackText = await popupPage.textContent('#connection-result');
    assert.match(feedbackText ?? '', /Offline sentence merger is ready/i);

    // Switch to Style tab & verify live preview updates
    await popupPage.click('#tab-style');
    assert.equal(await popupPage.isVisible('#panel-style'), true);
    await popupPage.click('[data-dual-order="translated-top"]');
    await popupPage.waitForTimeout(180);
    assert.equal(await popupPage.getAttribute('[data-dual-order="translated-top"]', 'aria-pressed'), 'true');
    const primaryPreview = await popupPage.textContent('#preview-primary');
    assert.match(primaryPreview ?? '', /Phụ đề YouTube/);

    if (SCREENSHOT_DIR) {
      await popupPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'popup-style.png') });
    }

    // Reset back to Original + Offline + original-top and verify persistence across reload
    await popupPage.click('[data-dual-order="original-top"]');
    await popupPage.click('#tab-subtitles');
    await popupPage.click('[data-mode="original"]');
    await popupPage.waitForTimeout(300);
    await popupPage.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await popupPage.getAttribute('[data-mode="original"]', 'aria-pressed'), 'true');
    assert.equal(popupErrors.length, 0, `Popup console/page errors: ${popupErrors.join('; ')}`);
    console.log('[E2E] Popup UI controls, tabs, live preview, and storage persistence PASSED');

    // 3. Test real YouTube page injection (MAIN page-bridge + ISOLATED content + Shadow DOM overlay + Player Control)
    const ytPage = await context.newPage();
    await ytPage.setViewportSize({ width: 1080, height: 680 });
    const ytErrors = [];
    ytPage.on('pageerror', (e) => ytErrors.push(e.message));

    await context.route('https://www.youtube.com/watch*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: YOUTUBE_HARNESS_HTML,
      });
    });

    await context.route('https://www.youtube.com/api/timedtext*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(SAMPLE_WORD_BY_WORD_JSON3),
      });
    });

    await ytPage.goto('https://www.youtube.com/watch?v=subflowDemo1', { waitUntil: 'domcontentloaded' });

    // Wait for Shadow DOM overlay & Player Control button to mount
    await ytPage.waitForSelector('#subflow-overlay-root', { timeout: 10_000 });
    await ytPage.waitForSelector('#subflow-player-toggle-btn', { timeout: 10_000 });

    // Wait for word-by-word ASR to merge into sentence-level cue at t=1.6s
    await ytPage.waitForFunction(() => {
      const host = document.getElementById('subflow-overlay-root');
      const primary = host?.shadowRoot?.querySelector('.sf-line-primary');
      return Boolean(primary && primary.textContent && primary.textContent.length > 15);
    }, { timeout: 10_000 });

    const firstSentence = await ytPage.evaluate(() => {
      const host = document.getElementById('subflow-overlay-root');
      return host?.shadowRoot?.querySelector('.sf-line-primary')?.textContent ?? '';
    });
    assert.equal(
      firstSentence,
      'Youtube auto captions scroll word by word and break every sentence',
    );

    // Verify YouTube native caption window is hidden while SubFlow is active
    const nativeCaptionOpacity = await ytPage.evaluate(() => {
      const el = document.querySelector('.ytp-caption-window-container');
      return el ? getComputedStyle(el).opacity : '1';
    });
    assert.equal(nativeCaptionOpacity, '0', 'YouTube native caption window must be hidden when SubFlow is ON');

    await ytPage.waitForTimeout(240);
    if (SCREENSHOT_DIR) {
      await ytPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'youtube-overlay-sentence.png') });
    }

    // Seek to second sentence (t=5.8s) and confirm subtitle updates cleanly without leftover words from sentence 1
    await ytPage.evaluate(() => window.__setDemoTime(5.8));
    await ytPage.waitForFunction(() => {
      const host = document.getElementById('subflow-overlay-root');
      const txt = host?.shadowRoot?.querySelector('.sf-line-primary')?.textContent ?? '';
      return txt === 'Subflow merges them cleanly into real readable lines';
    }, { timeout: 5000 });

    // Click native player SubFlow button -> opens Quick Switcher popover
    await ytPage.click('#subflow-player-toggle-btn');
    const popoverVisible = await ytPage.evaluate(() => {
      const popHost = document.getElementById('subflow-quick-popover-host');
      const panel = popHost?.shadowRoot?.querySelector('.sf-pop');
      return Boolean(panel && !panel.classList.contains('hidden'));
    });
    assert.equal(popoverVisible, true, 'Quick Switcher popover must open on player button click');

    if (SCREENSHOT_DIR) {
      await ytPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'youtube-quick-popover.png') });
    }

    // Toggle SubFlow OFF via Alt+S shortcut -> native YouTube captions must restore!
    await ytPage.keyboard.press('Alt+KeyS');
    await ytPage.waitForFunction(() => {
      const el = document.querySelector('.ytp-caption-window-container');
      return el && getComputedStyle(el).opacity === '1';
    }, { timeout: 5000 });

    // Toggle back ON via Alt+S
    await ytPage.keyboard.press('Alt+KeyS');
    await ytPage.waitForFunction(() => {
      const el = document.querySelector('.ytp-caption-window-container');
      return el && getComputedStyle(el).opacity === '0';
    }, { timeout: 5000 });

    assert.equal(ytErrors.length, 0, `YouTube content script errors: ${ytErrors.join('; ')}`);
    console.log('[E2E] YouTube content script, Shadow DOM overlay, sentence merging, native caption suppression, Quick Switcher, and Alt+S shortcut PASSED');
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('[E2E FAILED]', err);
  process.exit(1);
});
