/**
 * SubFlow Page Bridge (runs in MAIN world at document_start).
 * Safely reads YouTube player caption tracks and captures signed /api/timedtext responses
 * (including YouTube's Proof-of-Origin `pot` token) via fetch/XHR observation,
 * PerformanceResourceTiming lookup, and native YouTube caption track activation.
 */

export {};

interface RawCaptionTrack {
  languageCode?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
  baseUrl?: string;
  kind?: string;
  isTranslatable?: boolean;
}

interface RawAudioTrack {
  defaultCaptionTrackIndex?: number;
  hasDefaultTrack?: boolean;
}

interface PlayerResponseLike {
  videoDetails?: {
    videoId?: string;
    title?: string;
    defaultAudioLanguage?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: RawCaptionTrack[];
      audioTracks?: RawAudioTrack[];
    };
  };
}

interface PlayerTrackOption {
  languageCode?: string;
  kind?: string;
  vss_id?: string;
  displayName?: string;
}

interface MoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => PlayerResponseLike | null;
  loadModule?: (moduleName: string) => void;
  setOption?: (moduleName: string, option: string, value: unknown) => void;
  getOption?: (moduleName: string, option: string) => unknown;
  toggleSubtitles?: () => void;
}

declare global {
  interface Window {
    __SUBFLOW_BRIDGE_INSTALLED__?: boolean;
    ytInitialPlayerResponse?: PlayerResponseLike;
  }
}

(() => {
  if (window.__SUBFLOW_BRIDGE_INSTALLED__) return;
  window.__SUBFLOW_BRIDGE_INSTALLED__ = true;

  const interceptedByVideo = new Map<
    string,
    { url: string; lang: string; body: string; timestamp: number }
  >();
  const potByVideo = new Map<string, string>();
  const signedUrlByVideo = new Map<string, string>();

  function getCurrentVideoIdFromUrl(): string | null {
    try {
      const url = new URL(window.location.href);
      const v = url.searchParams.get('v');
      if (v) return v;
      const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{6,})/);
      if (shortsMatch) return shortsMatch[1];
      const liveMatch = url.pathname.match(/^\/live\/([a-zA-Z0-9_-]{6,})/);
      if (liveMatch) return liveMatch[1];
    } catch {
      // ignore
    }
    return null;
  }

  function extractTrackName(raw: RawCaptionTrack): string {
    if (raw.name?.simpleText) return raw.name.simpleText;
    if (Array.isArray(raw.name?.runs)) {
      return raw.name.runs.map((r) => r.text ?? '').join('').trim();
    }
    return raw.languageCode ?? 'Unknown';
  }

  function recordTimedTextUrlMeta(urlStr: string): void {
    try {
      const parsedUrl = new URL(urlStr, window.location.origin);
      const videoId = parsedUrl.searchParams.get('v') || getCurrentVideoIdFromUrl();
      const pot = parsedUrl.searchParams.get('pot');
      if (videoId && pot) {
        potByVideo.set(videoId, pot);
        signedUrlByVideo.set(videoId, parsedUrl.toString());
      }
    } catch {
      // ignore
    }
  }

  function recordTimedTextPayload(urlStr: string, body: string): void {
    recordTimedTextUrlMeta(urlStr);
    if (!body || body.trim().length < 10) return;
    try {
      const parsedUrl = new URL(urlStr, window.location.origin);
      const videoId = parsedUrl.searchParams.get('v') || getCurrentVideoIdFromUrl();
      if (!videoId) return;
      const lang = parsedUrl.searchParams.get('lang') || '';
      const tlang = parsedUrl.searchParams.get('tlang') || '';
      // Prefer original source tracks over YouTube's auto-translated timedtext
      if (tlang) return;

      interceptedByVideo.set(videoId, {
        url: parsedUrl.toString(),
        lang,
        body,
        timestamp: Date.now(),
      });

      window.postMessage(
        {
          source: 'SUBFLOW_PAGE',
          type: 'INTERCEPTED_TIMEDTEXT',
          videoId,
          lang,
          body,
        },
        '*',
      );
    } catch {
      // ignore
    }
  }

  // 1. Non-destructively observe window.fetch for /api/timedtext
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function subflowFetch(input: RequestInfo | URL, init?: RequestInit) {
    const response = await nativeFetch(input, init);
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url && url.includes('/api/timedtext')) {
        recordTimedTextUrlMeta(url);
        const cloned = response.clone();
        cloned
          .text()
          .then((text) => recordTimedTextPayload(url, text))
          .catch(() => {});
      }
    } catch {
      // Never interfere with YouTube's own requests
    }
    return response;
  };

  // 2. Non-destructively observe XMLHttpRequest for /api/timedtext
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function subflowXhrOpen(
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    (this as XMLHttpRequest & { __sfUrl?: string }).__sfUrl =
      typeof url === 'string' ? url : url.toString();
    return origOpen.apply(this, [method, url, ...(rest as [boolean, string?, string?])]);
  };

  XMLHttpRequest.prototype.send = function subflowXhrSend(
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const reqUrl = (this as XMLHttpRequest & { __sfUrl?: string }).__sfUrl;
    if (reqUrl && reqUrl.includes('/api/timedtext')) {
      recordTimedTextUrlMeta(reqUrl);
      this.addEventListener('load', () => {
        try {
          if (typeof this.responseText === 'string' && this.responseText.length > 0) {
            recordTimedTextPayload(reqUrl, this.responseText);
          }
        } catch {
          // ignore
        }
      });
    }
    return origSend.call(this, body);
  };

  /**
   * Scans PerformanceResourceTiming for any /api/timedtext URL YouTube already fetched
   * before our bridge was injected (e.g., when extension was loaded onto an already-open tab).
   */
  function findSignedTimedTextFromPerformance(videoId: string): string | null {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i]?.name;
        if (!name || !name.includes('/api/timedtext')) continue;
        const parsed = new URL(name);
        if (parsed.searchParams.get('v') !== videoId) continue;
        const pot = parsed.searchParams.get('pot');
        if (pot) {
          potByVideo.set(videoId, pot);
          if (!parsed.searchParams.get('tlang')) {
            return name;
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  function readPlayerData() {
    const player = document.getElementById('movie_player') as MoviePlayerElement | null;
    let resp: PlayerResponseLike | null = null;
    try {
      if (player && typeof player.getPlayerResponse === 'function') {
        resp = player.getPlayerResponse();
      }
    } catch {
      // ignore
    }

    const urlVideoId = getCurrentVideoIdFromUrl();
    if (
      (!resp || (urlVideoId && resp.videoDetails?.videoId !== urlVideoId)) &&
      window.ytInitialPlayerResponse
    ) {
      if (!urlVideoId || window.ytInitialPlayerResponse.videoDetails?.videoId === urlVideoId) {
        resp = window.ytInitialPlayerResponse;
      }
    }

    const videoId = resp?.videoDetails?.videoId ?? urlVideoId;
    const videoTitle = resp?.videoDetails?.title ?? document.title.replace(/ - YouTube$/, '');
    const defaultAudioLanguage = resp?.videoDetails?.defaultAudioLanguage ?? '';
    const renderer = resp?.captions?.playerCaptionsTracklistRenderer;
    const rawTracks = renderer?.captionTracks ?? [];
    const defaultTrackIdx = renderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;

    let activePlayerLang = '';
    try {
      const activeTrack = player?.getOption?.('captions', 'track') as PlayerTrackOption | undefined;
      if (activeTrack?.languageCode) {
        activePlayerLang = activeTrack.languageCode;
      }
    } catch {
      // ignore
    }

    const tracks = rawTracks
      .map((t, idx) => ({
        raw: t,
        isDefault: typeof defaultTrackIdx === 'number' && idx === defaultTrackIdx,
      }))
      .filter(({ raw }) => Boolean(raw.baseUrl && raw.languageCode))
      .map(({ raw, isDefault }) => ({
        languageCode: raw.languageCode as string,
        name: extractTrackName(raw),
        baseUrl: raw.baseUrl as string,
        kind: raw.kind,
        isTranslatable: raw.isTranslatable,
        isDefault,
      }));

    return { videoId, videoTitle, defaultAudioLanguage, activePlayerLang, tracks };
  }

  async function tryFetchUrl(urlStr: string): Promise<string> {
    try {
      const res = await nativeFetch(urlStr, { credentials: 'include' });
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 10) return text;
      }
    } catch {
      // ignore
    }
    return '';
  }

  function buildUrlWithParams(baseUrl: string, fmt: string | null, pot?: string): string {
    const url = new URL(baseUrl, window.location.origin);
    if (fmt) url.searchParams.set('fmt', fmt);
    if (pot && !url.searchParams.get('pot')) {
      url.searchParams.set('potc', '1');
      url.searchParams.set('pot', pot);
    }
    return url.toString();
  }

  async function fetchTrackPayload(
    videoId: string,
    baseUrl: string,
    languageCode: string,
  ): Promise<string> {
    // 1. Check already-intercepted timedtext body for this video
    const cached = interceptedByVideo.get(videoId);
    if (cached && (!languageCode || cached.lang === languageCode) && cached.body.trim().length > 10) {
      return cached.body;
    }

    // 2. Check previously observed signed URL (or PerformanceResourceTiming) stripping any tlang
    const perfSignedUrl =
      signedUrlByVideo.get(videoId) || findSignedTimedTextFromPerformance(videoId);
    if (perfSignedUrl) {
      const cleaned = new URL(perfSignedUrl, window.location.origin);
      cleaned.searchParams.delete('tlang');
      cleaned.searchParams.set('fmt', 'json3');
      const perfText = await tryFetchUrl(cleaned.toString());
      if (perfText) return perfText;
    }

    // 3. Try direct json3 / XML fetch (attaching any known POT token for this video)
    const knownPot = potByVideo.get(videoId);
    const directJson3 = await tryFetchUrl(buildUrlWithParams(baseUrl, 'json3', knownPot));
    if (directJson3) return directJson3;

    const directXml = await tryFetchUrl(buildUrlWithParams(baseUrl, null, knownPot));
    if (directXml) return directXml;

    // 4. Trigger YouTube's own player caption loader so YouTube mints a valid POT token
    //    and fetches signed /api/timedtext through our interceptor.
    const player = document.getElementById('movie_player') as MoviePlayerElement | null;
    if (player) {
      try {
        player.loadModule?.('captions');

        // Look up the exact internal track object from YouTube's tracklist
        const tracklist = player.getOption?.('captions', 'tracklist') as PlayerTrackOption[] | undefined;
        let targetTrackObj: PlayerTrackOption = { languageCode };
        if (Array.isArray(tracklist) && tracklist.length > 0) {
          const exactManual = tracklist.find(
            (t) => t.languageCode === languageCode && t.kind !== 'asr',
          );
          const exactAny = tracklist.find((t) => t.languageCode === languageCode);
          if (exactManual) targetTrackObj = exactManual;
          else if (exactAny) targetTrackObj = exactAny;
        }

        // If YouTube's CC button is currently OFF, click it so YouTube actually fetches timedtext
        const ccBtn = player.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
        const wasCcOff = ccBtn?.getAttribute('aria-pressed') === 'false';
        if (wasCcOff && ccBtn) {
          ccBtn.click();
        } else if (typeof player.setOption === 'function') {
          // Force reload of the selected track if CC was already on
          player.setOption('captions', 'track', {});
          await new Promise((r) => setTimeout(r, 80));
        }

        player.setOption?.('captions', 'track', targetTrackObj);

        // Wait up to 3.8s for YouTube's signed timedtext response or POT token
        const started = Date.now();
        while (Date.now() - started < 3800) {
          const hit = interceptedByVideo.get(videoId);
          if (hit && hit.body.trim().length > 10) {
            return hit.body;
          }
          const freshPot = potByVideo.get(videoId);
          if (freshPot && freshPot !== knownPot) {
            const potJson3 = await tryFetchUrl(buildUrlWithParams(baseUrl, 'json3', freshPot));
            if (potJson3) return potJson3;
          }
          await new Promise((r) => setTimeout(r, 180));
        }
      } catch {
        // ignore
      }
    }

    // Last chance: return any intercepted payload for this video regardless of language
    const fallbackCached = interceptedByVideo.get(videoId);
    if (fallbackCached && fallbackCached.body.trim().length > 10) {
      return fallbackCached.body;
    }

    return '';
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as
      | {
          source?: string;
          type?: string;
          requestId?: string;
          videoId?: string;
          baseUrl?: string;
          languageCode?: string;
        }
      | undefined;
    if (!msg || msg.source !== 'SUBFLOW_CONTENT') return;

    if (msg.type === 'GET_PLAYER_TRACKS') {
      const info = readPlayerData();
      const intercepted = info.videoId ? interceptedByVideo.get(info.videoId) : undefined;
      window.postMessage(
        {
          source: 'SUBFLOW_PAGE',
          type: 'PLAYER_TRACKS_RESULT',
          requestId: msg.requestId,
          ...info,
          interceptedBody: intercepted?.body ?? null,
          interceptedLang: intercepted?.lang ?? null,
        },
        '*',
      );
      return;
    }

    if (msg.type === 'FETCH_TRACK' && msg.baseUrl && msg.videoId) {
      fetchTrackPayload(msg.videoId, msg.baseUrl, msg.languageCode ?? '')
        .then((body) => {
          window.postMessage(
            {
              source: 'SUBFLOW_PAGE',
              type: 'FETCH_TRACK_RESULT',
              requestId: msg.requestId,
              body,
            },
            '*',
          );
        })
        .catch(() => {
          window.postMessage(
            {
              source: 'SUBFLOW_PAGE',
              type: 'FETCH_TRACK_RESULT',
              requestId: msg.requestId,
              body: '',
            },
            '*',
          );
        });
    }
  });
})();
