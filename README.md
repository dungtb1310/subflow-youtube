# SubFlow — Smart YouTube Subtitles

Chrome & Edge (Manifest V3) extension that replaces YouTube's choppy word-by-word auto-captions with clean sentence-level subtitles, customizable display modes (Refined Original, Translated, or Dual), and hybrid Cloud/Local AI processing.

## Key Features

- **No more word-by-word scrolling**: Parses YouTube's `timedtext` (`json3` / XML) captions and merges fragmented tokens into natural, readable sentence-level cues with accurate timestamps.
- **Instant offline mode**: Works out of the box with zero API keys using pause detection, punctuation heuristics, and English capitalization cleanup.
- **Flexible language modes**:
  - **Original**: Keeps the video's original language (e.g. English only) while fixing choppy segmentation and adding proper punctuation.
  - **Dual**: Displays both the refined original sentence and a contextual translation stacked cleanly.
  - **Translated**: Displays only the contextual translation in your selected language.
- **Hybrid Cloud + Local AI Engine**:
  - **Gemini API**: Uses Google's Gemini Interactions API v1 (`gemini-3.5-flash-lite`, `gemini-4-hydrogen`, `gemini-3.8-flash`, or custom model ID).
  - **Ollama (Local)**: Free, private local processing (`http://localhost:11434`) with one-click local model discovery.
  - **OpenAI-Compatible**: Built-in presets for OpenAI, Groq, OpenRouter, and LM Studio (or any custom `/v1` endpoint).
- **Seek-aware processing & IndexedDB cache**: Prioritizes the segment you are currently watching when seeking, prefetches ahead, and caches processed chunks locally.
- **Cinema-grade overlay & inline player controls**:
  - Shadow DOM overlay that hides YouTube's native captions while active (restores them when toggled off).
  - Drag subtitles vertically to adjust position; optional hover-to-pause for language learning.
  - Quick Switcher button inside the YouTube player control bar + `Alt + S` toggle shortcut.
  - One-click **Export .SRT** for the current video.

## Installation (Load Unpacked in Chrome / Edge)

1. Install dependencies and build the extension:
   ```bash
   npm install
   npm run build
   ```
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the generated `dist/` folder.
5. Open any YouTube video with captions enabled.

## Local Ollama Setup (Optional)

If you use Ollama locally and encounter HTTP `403` when the extension calls `localhost:11434`, allow browser extension origins before starting Ollama:

```bash
# PowerShell (Windows)
$env:OLLAMA_ORIGINS="chrome-extension://*"
ollama serve
```

## Development & Testing

```bash
npm run typecheck   # TypeScript strict check
npm test            # Unit tests (Vitest)
npm run build       # Build MV3 extension into dist/
npm run test:e2e    # Live Chrome MV3 extension E2E test (Playwright)
```

## Architecture

- `src/content/page-bridge.ts`: MAIN-world bridge for reading YouTube player tracks and observing signed `/api/timedtext` requests.
- `src/content/subtitle-manager.ts`: Caption ingestion, heuristic merging, seek-aware AI queue, and IndexedDB caching.
- `src/content/overlay.ts` & `src/content/player-control.ts`: Trusted-Types-safe Shadow DOM subtitle renderer and native YouTube control bar Quick Switcher.
- `src/background/ai-client.ts` & `src/background/service-worker.ts`: MV3 service worker handling Gemini Interactions API, Ollama, and OpenAI-compatible requests.
- `src/popup/`: Extension popup UI for modes, language selection, AI provider setup, and live style customization.
