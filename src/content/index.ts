import { loadSettings, saveSettings, subscribeSettings } from '../shared/storage';
import type { ContentRequest, SubFlowSettings } from '../shared/types';
import { SubtitleOverlay } from './overlay';
import { PlayerControl } from './player-control';
import { extractVideoIdFromUrl, SubtitleManager } from './subtitle-manager';

declare global {
  interface Window {
    __SUBFLOW_CONTENT_INITIALIZED__?: boolean;
  }
}

async function bootstrap(): Promise<void> {
  if (window.__SUBFLOW_CONTENT_INITIALIZED__) return;
  window.__SUBFLOW_CONTENT_INITIALIZED__ = true;

  let settings: SubFlowSettings = await loadSettings();

  const overlay = new SubtitleOverlay(settings, (bottomOffsetPercent) => {
    void saveSettings({ bottomOffsetPercent });
  });

  const playerControl = new PlayerControl(settings, {
    onPatchSettings: (patch) => {
      void saveSettings(patch);
    },
    onExportSrt: () => {
      manager.triggerSrtDownload();
    },
  });

  const manager = new SubtitleManager(settings, {
    onCueChange: (cue) => overlay.setCue(cue),
    onStatusChange: (status) => {
      overlay.setStatus(status);
      playerControl.setStatus(status);
    },
  });

  const applySettings = (next: SubFlowSettings) => {
    settings = next;
    overlay.updateSettings(next);
    playerControl.updateSettings(next);
    manager.updateSettings(next);
  };

  subscribeSettings(applySettings);

  let lastUrl = window.location.href;
  let lastVideoId: string | null = null;

  const ensurePlayerMounted = () => {
    const playerEl = document.querySelector<HTMLElement>('.html5-video-player');
    const videoEl = playerEl?.querySelector<HTMLVideoElement>('video.html5-main-video') ??
      playerEl?.querySelector<HTMLVideoElement>('video');

    if (playerEl) {
      overlay.mount(playerEl);
      playerControl.mount(playerEl);
    }
    if (videoEl) {
      manager.attachVideo(videoEl);
    }

    const videoId = extractVideoIdFromUrl(window.location.href);
    if (videoId !== lastVideoId) {
      lastVideoId = videoId;
      void manager.loadVideo(videoId);
    }
  };

  // Watch DOM mutations until YouTube mounts player & right controls
  const domObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      ensurePlayerMounted();
      return;
    }
    const playerEl = document.querySelector<HTMLElement>('.html5-video-player');
    if (playerEl && (!document.getElementById('subflow-overlay-root') || !document.getElementById('subflow-player-toggle-btn'))) {
      ensurePlayerMounted();
    }
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });

  // YouTube SPA navigation hooks
  window.addEventListener('yt-navigate-finish', () => {
    lastUrl = window.location.href;
    ensurePlayerMounted();
  });
  window.addEventListener('popstate', () => {
    lastUrl = window.location.href;
    ensurePlayerMounted();
  });
  document.addEventListener('fullscreenchange', () => {
    overlay.updateSettings(settings);
  });

  // Global keyboard shortcut: Alt + S toggles SubFlow on/off
  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.key.toLowerCase() !== 's') return;
    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    ev.preventDefault();
    void saveSettings({ enabled: !settings.enabled });
  });

  // Respond to Popup requests on the active YouTube tab
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return false;

      if (message.type === 'GET_STATUS') {
        sendResponse(manager.getStatus());
        return false;
      }
      if (message.type === 'EXPORT_SRT') {
        sendResponse(manager.exportCurrentSrt());
        return false;
      }
      if (message.type === 'CLEAR_CACHE') {
        manager
          .clearCacheAndReprocess()
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      if (message.type === 'REPROCESS_VIDEO') {
        manager
          .reprocessCurrentVideo()
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      return false;
    });
  }

  ensurePlayerMounted();
}

void bootstrap();
