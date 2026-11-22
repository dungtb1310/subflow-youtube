/**
 * SubFlow Page Bridge (runs in MAIN world at document_start).
 * Safely reads YouTube player caption tracks and intercepts signed /api/timedtext responses
 * so SubFlow works reliably even when YouTube attaches POT (Proof-of-Origin) tokens.
 */

export {};

interface RawCaptionTrack {
  languageCode?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
  baseUrl?: string;
  kind?: string;
  isTranslatable?: boolean;
}

interface PlayerResponseLike {
  videoDetails?: {
    videoId?: string;
    title?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: RawCaptionTrack[];
    };
  };
}

interface MoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => PlayerResponseLike | null;
  loadModule?: (moduleName: string) => void;
  setOption?: (moduleName: string, option: string, value: unknown) => void;
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

  function recordTimedTextPayload(urlStr: string, body: string): void {
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
    const rawTracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const tracks = rawTracks
      .filter((t) => Boolean(t.baseUrl && t.languageCode))
      .map((t) => ({
        languageCode: t.languageCode as string,
        name: extractTrackName(t),
        baseUrl: t.baseUrl as string,
        kind: t.kind,
        isTranslatable: t.isTranslatable,
      }));

    return { videoId, videoTitle, tracks };
  }

  async function fetchTrackPayload(
    videoId: string,
    baseUrl: string,
    languageCode: string,
  ): Promise<string> {
    // Check if we already intercepted a fresh timedtext body for this video
    const cached = interceptedByVideo.get(videoId);
    if (cached && (!languageCode || cached.lang === languageCode) && cached.body.trim().length > 10) {
      return cached.body;
    }

    // Try direct json3 fetch with page credentials
    const json3Url = new URL(baseUrl, window.location.origin);
    json3Url.searchParams.set('fmt', 'json3');

    try {
      const res = await nativeFetch(json3Url.toString(), { credentials: 'include' });
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 10) {
          return text;
        }
      }
    } catch {
      // fall through to XML or player trigger
    }

    // Try plain XML baseUrl without fmt=json3
    try {
      const resXml = await nativeFetch(baseUrl, { credentials: 'include' });
      if (resXml.ok) {
        const text = await resXml.text();
        if (text.trim().length > 10) {
          return text;
        }
      }
    } catch {
      // fall through
    }

    // Final fallback: ask YouTube's own player to load the caption track so our interceptor captures signed POT request
    const player = document.getElementById('movie_player') as MoviePlayerElement | null;
    if (player && typeof player.loadModule === 'function' && typeof player.setOption === 'function') {
      try {
        player.loadModule('captions');
        player.setOption('captions', 'track', { languageCode });
        // Wait up to 2.5s for YouTube's signed timedtext request to pass through our interceptor
        const started = Date.now();
        while (Date.now() - started < 2500) {
          const hit = interceptedByVideo.get(videoId);
          if (hit && hit.body.trim().length > 10) {
            return hit.body;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      } catch {
        // ignore
      }
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
