/**
 * Universal Live Subtitle Overlay for any non-YouTube tab (Twitch, Kick, Facebook Live, Zoom Web, etc.).
 * Injected on demand by the MV3 service worker when the user starts Live Audio on a non-YouTube tab.
 * 100% Trusted-Types safe (no innerHTML).
 */

import { DEFAULT_SETTINGS } from '../shared/constants';
import { loadSettings, saveSettings, subscribeSettings } from '../shared/storage';
import type { ContentRequest, LiveSessionState, SubFlowSettings, SubtitleCue } from '../shared/types';

declare global {
  interface Window {
    __BETTERSUBTITLE_LIVE_OVERLAY__?: boolean;
  }
}

const HOST_ID = 'bettersubtitle-universal-live-overlay';

const UNIVERSAL_STYLES = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483646;
  font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

.bs-stage {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--bs-bottom, 9%);
  width: min(86vw, 960px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.bs-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(15, 17, 21, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #D9DFEB;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 160ms ease-out;
}

.bs-chip.visible {
  opacity: 1;
}

.bs-chip.is-error {
  border-color: rgba(242, 108, 108, 0.45);
  color: #FFD5D5;
}

.bs-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #F5B942;
}

.bs-chip.is-error .bs-dot {
  background: #F26C6C;
}

.bs-box {
  pointer-events: auto;
  cursor: grab;
  max-width: 100%;
  padding: 10px 18px 11px;
  border-radius: 10px;
  background: rgba(13, 16, 22, var(--bs-bg-opacity, 0.8));
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
}

.bs-box:active {
  cursor: grabbing;
}

.bs-line {
  margin: 0;
  line-height: 1.38;
  text-wrap: balance;
  word-break: break-word;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 2px 8px rgba(0, 0, 0, 0.72);
}

.bs-primary {
  font-size: var(--bs-font-size, 22px);
  font-weight: 600;
  color: #F6F7FA;
}

.bs-box.is-interim .bs-primary {
  color: #CBD3E1;
}

.bs-secondary {
  font-size: calc(var(--bs-font-size, 22px) * 0.85);
  font-weight: 500;
  color: #F8D589;
}

.hidden {
  display: none !important;
}
`;

function mountUniversalOverlay(): void {
  if (window.__BETTERSUBTITLE_LIVE_OVERLAY__) return;
  window.__BETTERSUBTITLE_LIVE_OVERLAY__ = true;

  let settings: SubFlowSettings = { ...DEFAULT_SETTINGS };
  let currentCue: SubtitleCue | null = null;
  let liveState: { active: boolean; state: LiveSessionState; error?: string } | null = null;

  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = UNIVERSAL_STYLES;
  shadow.appendChild(styleEl);

  const stage = document.createElement('div');
  stage.className = 'bs-stage hidden';

  const chip = document.createElement('div');
  chip.className = 'bs-chip';
  const dot = document.createElement('span');
  dot.className = 'bs-dot';
  const chipText = document.createElement('span');
  chip.append(dot, chipText);

  const box = document.createElement('div');
  box.className = 'bs-box hidden';
  box.title = 'Drag vertically to reposition live subtitles';

  const primaryEl = document.createElement('p');
  primaryEl.className = 'bs-line bs-primary';

  const secondaryEl = document.createElement('p');
  secondaryEl.className = 'bs-line bs-secondary hidden';

  box.append(primaryEl, secondaryEl);
  stage.append(chip, box);
  shadow.appendChild(stage);

  const attachHostToContainer = () => {
    const target = document.fullscreenElement || document.body || document.documentElement;
    if (target && host.parentElement !== target) {
      target.appendChild(host);
    }
  };
  attachHostToContainer();
  document.addEventListener('fullscreenchange', attachHostToContainer);

  const applyStyles = () => {
    host.style.setProperty('--bs-font-size', `${settings.fontSize}px`);
    host.style.setProperty('--bs-bg-opacity', String(settings.bgOpacity));
    host.style.setProperty('--bs-bottom', `${settings.bottomOffsetPercent}%`);
  };

  const render = () => {
    applyStyles();
    const visible = Boolean(liveState?.active || liveState?.state === 'error');
    stage.classList.toggle('hidden', !visible);

    chip.classList.remove('visible', 'is-error');
    if (liveState?.state === 'connecting') {
      chipText.textContent = 'Live Audio: Connecting...';
      chip.classList.add('visible');
    } else if (liveState?.state === 'reconnecting') {
      chipText.textContent = 'Live Audio: Reconnecting...';
      chip.classList.add('visible');
    } else if (liveState?.state === 'error' && liveState.error) {
      chipText.textContent = liveState.error;
      chip.classList.add('visible', 'is-error');
    } else if (liveState?.state === 'listening' && !currentCue) {
      chipText.textContent = 'Live Audio: Listening...';
      chip.classList.add('visible');
    }

    if (!currentCue || !liveState?.active) {
      box.classList.add('hidden');
      return;
    }

    let primary = '';
    let secondary = '';
    if (settings.mode === 'original') {
      primary = currentCue.original;
    } else if (settings.mode === 'translated') {
      primary = currentCue.translated || currentCue.original;
    } else if (currentCue.translated && currentCue.translated !== currentCue.original) {
      if (settings.dualOrder === 'translated-top') {
        primary = currentCue.translated;
        secondary = currentCue.original;
      } else {
        primary = currentCue.original;
        secondary = currentCue.translated;
      }
    } else {
      primary = currentCue.original;
    }

    primaryEl.textContent = primary;
    if (secondary.trim()) {
      secondaryEl.textContent = secondary;
      secondaryEl.classList.remove('hidden');
    } else {
      secondaryEl.textContent = '';
      secondaryEl.classList.add('hidden');
    }

    box.classList.toggle('is-interim', Boolean(currentCue.isInterim));
    box.classList.toggle('hidden', !primary.trim());
  };

  // Vertical drag support
  let dragging = false;
  let startY = 0;
  let startBottomPx = 0;
  box.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    startY = ev.clientY;
    startBottomPx = (settings.bottomOffsetPercent / 100) * window.innerHeight;
    box.setPointerCapture(ev.pointerId);
  });
  box.addEventListener('pointermove', (ev) => {
    if (!dragging || window.innerHeight <= 0) return;
    const nextPx = startBottomPx + (startY - ev.clientY);
    const nextPct = Math.round(Math.min(78, Math.max(4, (nextPx / window.innerHeight) * 100)));
    settings = { ...settings, bottomOffsetPercent: nextPct };
    host.style.setProperty('--bs-bottom', `${nextPct}%`);
  });
  const endDrag = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (box.hasPointerCapture(ev.pointerId)) box.releasePointerCapture(ev.pointerId);
    void saveSettings({ bottomOffsetPercent: settings.bottomOffsetPercent });
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  subscribeSettings((next) => {
    settings = next;
    render();
  });

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return false;

    if (msg.type === 'LIVE_SESSION_STATE') {
      liveState = msg.payload;
      if (!msg.payload.active) {
        currentCue = null;
      }
      render();
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'LIVE_SUBTITLE_UPDATE') {
      liveState = { active: true, state: 'listening' };
      currentCue = {
        id: msg.payload.id,
        startMs: msg.payload.timestampMs,
        endMs: msg.payload.timestampMs + 4000,
        original: msg.payload.original,
        translated: msg.payload.translated,
        source: 'live',
        isInterim: !msg.payload.isFinal,
      };
      render();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  applyStyles();
  void loadSettings().then((loaded) => {
    settings = loaded;
    render();
  });
}

mountUniversalOverlay();
