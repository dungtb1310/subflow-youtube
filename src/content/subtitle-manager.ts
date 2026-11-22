import { buildChunkCacheKey, clearAllCache, getCachedChunk, setCachedChunk } from '../shared/cache';
import {
  findCueAtTime,
  mergeWordsToHeuristicCues,
  splitWordsIntoAiChunks,
} from '../shared/chunker';
import { exportCuesToSrt } from '../shared/srt';
import { parseYouTubeTranscript } from '../shared/transcript-parser';
import type {
  BackgroundRequest,
  CaptionTrackInfo,
  ProcessChunkResponse,
  RuntimeStatus,
  SubFlowSettings,
  SubtitleCue,
  TranscriptChunk,
  WordToken,
} from '../shared/types';

interface BridgePlayerTracksResult {
  videoId: string | null;
  videoTitle: string;
  defaultAudioLanguage?: string;
  activePlayerLang?: string;
  tracks: CaptionTrackInfo[];
  interceptedBody: string | null;
  interceptedLang: string | null;
}

export function extractVideoIdFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
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

function normalizeLangPrefix(code?: string): string {
  return (code ?? '').toLowerCase().split('-')[0];
}

export function pickBestCaptionTrack(
  tracks: CaptionTrackInfo[],
  hints?: { defaultAudioLanguage?: string; activePlayerLang?: string },
): CaptionTrackInfo | null {
  if (tracks.length === 0) return null;

  // 1. Identify the video's native spoken language.
  //    YouTube's ASR track is always generated in the video's original audio language,
  //    unlike captionTracks[] which is sorted alphabetically (ar, bn, zh, ..., en).
  const asrTrack = tracks.find((t) => t.kind === 'asr');
  const defaultMarked = tracks.find((t) => t.isDefault);
  const nativeLangPrefix = normalizeLangPrefix(
    hints?.defaultAudioLanguage || asrTrack?.languageCode || defaultMarked?.languageCode,
  );

  if (nativeLangPrefix) {
    // Prefer manual captions in the video's native spoken language first
    const nativeManual = tracks.find(
      (t) => t.kind !== 'asr' && normalizeLangPrefix(t.languageCode) === nativeLangPrefix,
    );
    if (nativeManual) return nativeManual;

    // Next prefer the native ASR track
    const nativeAsr = tracks.find(
      (t) => t.kind === 'asr' && normalizeLangPrefix(t.languageCode) === nativeLangPrefix,
    );
    if (nativeAsr) return nativeAsr;
  }

  // 2. Respect YouTube's default track index if present
  if (defaultMarked) return defaultMarked;

  // 3. Respect currently active player caption language
  if (hints?.activePlayerLang) {
    const activeMatch = tracks.find(
      (t) => normalizeLangPrefix(t.languageCode) === normalizeLangPrefix(hints.activePlayerLang),
    );
    if (activeMatch) return activeMatch;
  }

  // 4. Fallback to English if available, then first track
  const english = tracks.find((t) => normalizeLangPrefix(t.languageCode) === 'en');
  if (english) return english;

  return tracks[0];
}

function getActiveModelName(settings: SubFlowSettings): string {
  switch (settings.provider) {
    case 'gemini':
      return settings.geminiModel;
    case 'ollama':
      return settings.ollamaModel;
    case 'openai':
      return settings.openaiModel;
    default:
      return 'heuristic';
  }
}

export class SubtitleManager {
  private settings: SubFlowSettings;
  private onCueChange: (cue: SubtitleCue | null) => void;
  private onStatusChange: (status: RuntimeStatus) => void;

  private videoEl: HTMLVideoElement | null = null;
  private currentVideoId: string | null = null;
  private videoTitle = '';
  private currentTrack: CaptionTrackInfo | null = null;
  private words: WordToken[] = [];
  private chunks: TranscriptChunk[] = [];
  private chunkCues = new Map<number, SubtitleCue[]>();
  private processedChunkIndices = new Set<number>();
  private flatCues: SubtitleCue[] = [];

  private epoch = 0;
  private pendingAiQueue: number[] = [];
  private inFlightChunks = new Set<number>();
  private aiRunning = false;
  private aiHaltedError: string | null = null;

  private rafId: number | null = null;
  private bridgeReqCounter = 0;
  private pendingBridgeRequests = new Map<string, (data: unknown) => void>();

  private status: RuntimeStatus;

  private handleWindowMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as
      | {
          source?: string;
          type?: string;
          requestId?: string;
          videoId?: string;
          lang?: string;
          body?: string;
        }
      | undefined;
    if (!msg || msg.source !== 'SUBFLOW_PAGE') return;

    if (msg.requestId && this.pendingBridgeRequests.has(msg.requestId)) {
      const resolver = this.pendingBridgeRequests.get(msg.requestId);
      this.pendingBridgeRequests.delete(msg.requestId);
      resolver?.(msg);
      return;
    }

    // Handle organic intercepted timedtext payload (e.g. user toggles CC or YouTube finishes POT fetch)
    if (
      msg.type === 'INTERCEPTED_TIMEDTEXT' &&
      msg.videoId &&
      msg.videoId === this.currentVideoId &&
      msg.body &&
      (this.words.length === 0 || (msg.lang && msg.lang !== this.status.sourceLanguage))
    ) {
      const parsed = parseYouTubeTranscript(msg.body);
      if (parsed.length > 0) {
        this.ingestWords(
          parsed,
          msg.lang || this.currentTrack?.languageCode || 'en',
          this.currentTrack?.name || msg.lang || 'Captions',
        );
      }
    }
  };

  private handleSeeked = () => {
    this.updateActiveCue();
    if (this.chunks.length > 0 && this.settings.provider !== 'offline' && !this.aiHaltedError) {
      this.reprioritizeQueue();
      this.pumpAiQueue();
    }
  };

  private handleTimeUpdate = () => {
    this.updateActiveCue();
  };

  constructor(
    initialSettings: SubFlowSettings,
    callbacks: {
      onCueChange: (cue: SubtitleCue | null) => void;
      onStatusChange: (status: RuntimeStatus) => void;
    },
  ) {
    this.settings = initialSettings;
    this.onCueChange = callbacks.onCueChange;
    this.onStatusChange = callbacks.onStatusChange;
    this.status = {
      state: 'idle',
      videoId: null,
      videoTitle: '',
      trackName: '',
      sourceLanguage: '',
      totalChunks: 0,
      processedChunks: 0,
      cueCount: 0,
      provider: initialSettings.provider,
      mode: initialSettings.mode,
    };

    window.addEventListener('message', this.handleWindowMessage);
  }

  public destroy(): void {
    this.epoch++;
    window.removeEventListener('message', this.handleWindowMessage);
    this.detachVideo();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public getStatus(): RuntimeStatus {
    return { ...this.status };
  }

  public attachVideo(videoEl: HTMLVideoElement): void {
    if (this.videoEl === videoEl) return;
    this.detachVideo();
    this.videoEl = videoEl;
    videoEl.addEventListener('timeupdate', this.handleTimeUpdate);
    videoEl.addEventListener('seeked', this.handleSeeked);
    videoEl.addEventListener('play', this.handleTimeUpdate);
    this.startSyncLoop();
  }

  private detachVideo(): void {
    if (!this.videoEl) return;
    this.videoEl.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.videoEl.removeEventListener('seeked', this.handleSeeked);
    this.videoEl.removeEventListener('play', this.handleTimeUpdate);
    this.videoEl = null;
  }

  private startSyncLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      if (this.videoEl && !this.videoEl.paused) {
        this.updateActiveCue();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public updateSettings(next: SubFlowSettings): void {
    const prev = this.settings;
    const needsReprocess =
      prev.mode !== next.mode ||
      prev.targetLanguage !== next.targetLanguage ||
      prev.provider !== next.provider ||
      prev.geminiModel !== next.geminiModel ||
      prev.geminiApiKey !== next.geminiApiKey ||
      prev.ollamaUrl !== next.ollamaUrl ||
      prev.ollamaModel !== next.ollamaModel ||
      prev.openaiBaseUrl !== next.openaiBaseUrl ||
      prev.openaiApiKey !== next.openaiApiKey ||
      prev.openaiModel !== next.openaiModel;

    const justEnabled = !prev.enabled && next.enabled;
    this.settings = next;

    if (!next.enabled) {
      this.onCueChange(null);
      return;
    }

    if (justEnabled && this.currentVideoId && this.words.length === 0) {
      void this.loadVideo(this.currentVideoId, true);
      return;
    }

    if (needsReprocess && this.words.length > 0) {
      this.startPipelineForCurrentWords();
    } else {
      this.updateActiveCue();
    }
  }

  public async loadVideo(videoId: string | null, force = false): Promise<void> {
    if (!videoId) {
      this.resetState(null);
      return;
    }
    if (!force && videoId === this.currentVideoId && this.words.length > 0) {
      return;
    }

    const myEpoch = ++this.epoch;
    this.resetState(videoId);

    if (!this.settings.enabled) {
      return;
    }

    this.emitStatus({
      state: 'loading',
      videoId,
      message: undefined,
    });

    // Retry briefly while YouTube finishes hydrating ytInitialPlayerResponse on SPA navigation
    let playerData: BridgePlayerTracksResult | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (myEpoch !== this.epoch) return;
      playerData = await this.requestPlayerTracks();
      if (
        playerData &&
        playerData.videoId === videoId &&
        (playerData.tracks.length > 0 || playerData.interceptedBody)
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    if (myEpoch !== this.epoch) return;

    if (!playerData || (playerData.tracks.length === 0 && !playerData.interceptedBody)) {
      this.emitStatus({
        state: 'no-captions',
        videoId,
        videoTitle: playerData?.videoTitle ?? document.title.replace(/ - YouTube$/, ''),
        message: 'No YouTube captions available for this video.',
      });
      return;
    }

    this.videoTitle = playerData.videoTitle || document.title.replace(/ - YouTube$/, '');
    const bestTrack = pickBestCaptionTrack(playerData.tracks, {
      defaultAudioLanguage: playerData.defaultAudioLanguage,
      activePlayerLang: playerData.activePlayerLang,
    });
    this.currentTrack = bestTrack;

    let rawPayload = '';
    if (bestTrack) {
      rawPayload = await this.requestTrackBody(videoId, bestTrack.baseUrl, bestTrack.languageCode);
    }
    if (!rawPayload && playerData.interceptedBody) {
      rawPayload = playerData.interceptedBody;
    }

    if (myEpoch !== this.epoch) return;

    const words = parseYouTubeTranscript(rawPayload);
    if (words.length === 0) {
      this.emitStatus({
        state: 'no-captions',
        videoId,
        videoTitle: this.videoTitle,
        trackName: bestTrack?.name ?? '',
        message: 'Caption track returned empty transcript.',
      });
      return;
    }

    this.ingestWords(
      words,
      bestTrack?.languageCode || playerData.interceptedLang || 'en',
      bestTrack?.name || bestTrack?.languageCode || 'Captions',
    );
  }

  public async reprocessCurrentVideo(): Promise<void> {
    if (this.words.length > 0) {
      this.startPipelineForCurrentWords();
    } else if (this.currentVideoId) {
      await this.loadVideo(this.currentVideoId, true);
    }
  }

  public async clearCacheAndReprocess(): Promise<void> {
    await clearAllCache();
    await this.reprocessCurrentVideo();
  }

  public exportCurrentSrt(): { ok: boolean; filename?: string; srt?: string; error?: string } {
    if (this.flatCues.length === 0) {
      return { ok: false, error: 'No subtitles loaded for this video yet.' };
    }
    const srt = exportCuesToSrt(this.flatCues, this.settings.mode, this.settings.dualOrder);
    const safeTitle = (this.videoTitle || this.currentVideoId || 'subtitles')
      .replace(/[<>:"/\\|?*]+/g, '')
      .trim()
      .slice(0, 64);
    const suffix =
      this.settings.mode === 'original'
        ? this.status.sourceLanguage || 'orig'
        : this.settings.mode === 'dual'
          ? `dual-${this.settings.targetLanguage}`
          : this.settings.targetLanguage;
    return {
      ok: true,
      filename: `${safeTitle || 'subflow'}.${suffix}.srt`,
      srt,
    };
  }

  public triggerSrtDownload(): void {
    const exported = this.exportCurrentSrt();
    if (!exported.ok || !exported.srt || !exported.filename) return;
    const blob = new Blob([exported.srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exported.filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private resetState(videoId: string | null): void {
    this.currentVideoId = videoId;
    this.videoTitle = '';
    this.currentTrack = null;
    this.words = [];
    this.chunks = [];
    this.chunkCues.clear();
    this.processedChunkIndices.clear();
    this.flatCues = [];
    this.pendingAiQueue = [];
    this.inFlightChunks.clear();
    this.aiRunning = false;
    this.aiHaltedError = null;
    this.onCueChange(null);
    this.emitStatus({
      state: 'idle',
      videoId,
      videoTitle: '',
      trackName: '',
      sourceLanguage: '',
      totalChunks: 0,
      processedChunks: 0,
      cueCount: 0,
      message: undefined,
    });
  }

  private ingestWords(words: WordToken[], sourceLang: string, trackName: string): void {
    this.words = words;
    this.chunks = splitWordsIntoAiChunks(words);
    this.emitStatus({
      sourceLanguage: sourceLang,
      trackName,
      videoTitle: this.videoTitle,
      totalChunks: this.chunks.length,
    });
    this.startPipelineForCurrentWords();
  }

  private startPipelineForCurrentWords(): void {
    const myEpoch = ++this.epoch;
    this.chunkCues.clear();
    this.processedChunkIndices.clear();
    this.pendingAiQueue = [];
    this.inFlightChunks.clear();
    this.aiRunning = false;
    this.aiHaltedError = null;

    // 1. Immediately generate offline sentence-merged cues for every chunk (<10ms)
    for (const chunk of this.chunks) {
      const heuristic = mergeWordsToHeuristicCues(chunk.words, {
        languageCode: this.status.sourceLanguage,
      });
      this.chunkCues.set(chunk.chunkIndex, heuristic);
    }
    this.rebuildFlatCues();
    this.updateActiveCue();

    // 2. If provider is Offline, we are immediately ready
    if (this.settings.provider === 'offline') {
      const note =
        this.settings.mode !== 'original'
          ? 'Offline mode active — select Gemini, Ollama, or OpenAI in SubFlow to translate.'
          : undefined;
      this.emitStatus({
        state: 'ready',
        processedChunks: this.chunks.length,
        totalChunks: this.chunks.length,
        cueCount: this.flatCues.length,
        message: note,
      });
      return;
    }

    // 3. Hydrate cached AI chunks from IndexedDB, then queue uncached chunks seek-first
    void this.hydrateCacheAndStartAi(myEpoch);
  }

  private async hydrateCacheAndStartAi(myEpoch: number): Promise<void> {
    if (!this.currentVideoId) return;
    const model = getActiveModelName(this.settings);
    const uncached: number[] = [];

    for (const chunk of this.chunks) {
      if (myEpoch !== this.epoch) return;
      const key = buildChunkCacheKey({
        videoId: this.currentVideoId,
        sourceLang: this.status.sourceLanguage || 'en',
        mode: this.settings.mode,
        targetLang: this.settings.targetLanguage,
        provider: this.settings.provider,
        model,
        chunkIndex: chunk.chunkIndex,
      });
      const cached = await getCachedChunk(key);
      if (myEpoch !== this.epoch) return;

      if (cached && cached.length > 0) {
        this.chunkCues.set(chunk.chunkIndex, cached);
        this.processedChunkIndices.add(chunk.chunkIndex);
      } else {
        uncached.push(chunk.chunkIndex);
      }
    }

    this.rebuildFlatCues();
    this.updateActiveCue();

    if (uncached.length === 0) {
      this.emitStatus({
        state: 'ready',
        processedChunks: this.chunks.length,
        totalChunks: this.chunks.length,
        cueCount: this.flatCues.length,
        message: undefined,
      });
      return;
    }

    this.pendingAiQueue = uncached;
    this.reprioritizeQueue();
    this.emitStatus({
      state: 'processing',
      processedChunks: this.processedChunkIndices.size,
      totalChunks: this.chunks.length,
      cueCount: this.flatCues.length,
      message: undefined,
    });
    this.pumpAiQueue(myEpoch);
  }

  private getCurrentChunkIndex(): number {
    if (this.chunks.length === 0) return 0;
    const currentMs = (this.videoEl?.currentTime ?? 0) * 1000;
    for (const chunk of this.chunks) {
      if (currentMs >= chunk.startMs && currentMs <= chunk.endMs) {
        return chunk.chunkIndex;
      }
      if (chunk.startMs > currentMs) {
        return Math.max(0, chunk.chunkIndex - 1);
      }
    }
    return this.chunks.length - 1;
  }

  private reprioritizeQueue(): void {
    const anchor = this.getCurrentChunkIndex();
    const pendingSet = new Set(
      this.pendingAiQueue.filter(
        (idx) => !this.processedChunkIndices.has(idx) && !this.inFlightChunks.has(idx),
      ),
    );

    const ordered: number[] = [];
    // Forward from current playback position first (current, current+1, current+2, ...)
    for (let idx = anchor; idx < this.chunks.length; idx++) {
      if (pendingSet.has(idx)) {
        ordered.push(idx);
        pendingSet.delete(idx);
      }
    }
    // Then earlier chunks if user started mid-video
    for (let idx = anchor - 1; idx >= 0; idx--) {
      if (pendingSet.has(idx)) {
        ordered.push(idx);
        pendingSet.delete(idx);
      }
    }
    this.pendingAiQueue = ordered;
  }

  private pumpAiQueue(expectedEpoch = this.epoch): void {
    if (expectedEpoch !== this.epoch || this.aiHaltedError) return;
    const maxConcurrency = this.settings.provider === 'ollama' ? 1 : 2;

    while (
      this.inFlightChunks.size < maxConcurrency &&
      this.pendingAiQueue.length > 0 &&
      !this.aiHaltedError
    ) {
      const nextIdx = this.pendingAiQueue.shift();
      if (nextIdx === undefined) break;
      if (this.processedChunkIndices.has(nextIdx) || this.inFlightChunks.has(nextIdx)) continue;

      this.inFlightChunks.add(nextIdx);
      this.aiRunning = true;
      void this.runSingleAiChunk(nextIdx, expectedEpoch);
    }

    if (this.inFlightChunks.size === 0 && this.pendingAiQueue.length === 0) {
      this.aiRunning = false;
      if (!this.aiHaltedError) {
        this.emitStatus({
          state: 'ready',
          processedChunks: this.processedChunkIndices.size,
          totalChunks: this.chunks.length,
          cueCount: this.flatCues.length,
          message: undefined,
        });
      }
    }
  }

  private async runSingleAiChunk(chunkIndex: number, expectedEpoch: number): Promise<void> {
    const chunk = this.chunks[chunkIndex];
    if (!chunk || expectedEpoch !== this.epoch) {
      this.inFlightChunks.delete(chunkIndex);
      return;
    }

    // Grab previous chunk's last sentence for smoother cross-chunk continuity
    const prevCues = chunkIndex > 0 ? this.chunkCues.get(chunkIndex - 1) : undefined;
    const previousContext = prevCues?.[prevCues.length - 1]?.original;

    try {
      const resp = await this.sendBackgroundProcessChunk({
        words: chunk.words,
        sourceLanguage: this.status.sourceLanguage || 'en',
        targetLanguage: this.settings.targetLanguage,
        mode: this.settings.mode,
        settings: this.settings,
        previousContext,
      });

      if (expectedEpoch !== this.epoch) return;

      if (!resp.ok || !resp.cues) {
        throw new Error(resp.error || 'AI subtitle processing failed.');
      }

      this.chunkCues.set(chunkIndex, resp.cues);
      this.processedChunkIndices.add(chunkIndex);

      if (this.currentVideoId) {
        const key = buildChunkCacheKey({
          videoId: this.currentVideoId,
          sourceLang: this.status.sourceLanguage || 'en',
          mode: this.settings.mode,
          targetLang: this.settings.targetLanguage,
          provider: this.settings.provider,
          model: getActiveModelName(this.settings),
          chunkIndex,
        });
        void setCachedChunk(key, resp.cues);
      }

      this.rebuildFlatCues();
      this.updateActiveCue();

      this.emitStatus({
        state:
          this.processedChunkIndices.size >= this.chunks.length ? 'ready' : 'processing',
        processedChunks: this.processedChunkIndices.size,
        totalChunks: this.chunks.length,
        cueCount: this.flatCues.length,
        message: undefined,
      });
    } catch (err) {
      if (expectedEpoch !== this.epoch) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.aiHaltedError = msg;
      this.pendingAiQueue = [];
      this.emitStatus({
        state: 'error',
        processedChunks: this.processedChunkIndices.size,
        totalChunks: this.chunks.length,
        cueCount: this.flatCues.length,
        message: msg,
      });
    } finally {
      this.inFlightChunks.delete(chunkIndex);
      if (expectedEpoch === this.epoch && !this.aiHaltedError) {
        this.pumpAiQueue(expectedEpoch);
      } else if (this.inFlightChunks.size === 0) {
        this.aiRunning = false;
      }
    }
  }

  private sendBackgroundProcessChunk(
    payload: Extract<BackgroundRequest, { type: 'PROCESS_CHUNK' }>['payload'],
  ): Promise<ProcessChunkResponse> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        resolve({ ok: false, error: 'Extension runtime unavailable.' });
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'PROCESS_CHUNK', payload } satisfies BackgroundRequest,
        (response?: ProcessChunkResponse) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response ?? { ok: false, error: 'Empty response from background worker.' });
        },
      );
    });
  }

  private rebuildFlatCues(): void {
    const merged: SubtitleCue[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const part = this.chunkCues.get(i);
      if (part) merged.push(...part);
    }
    merged.sort((a, b) => a.startMs - b.startMs);
    // Keep cross-chunk timestamps strictly non-overlapping
    for (let i = 0; i < merged.length - 1; i++) {
      if (merged[i].endMs > merged[i + 1].startMs - 15) {
        merged[i].endMs = Math.max(merged[i].startMs + 200, merged[i + 1].startMs - 15);
      }
    }
    this.flatCues = merged;
  }

  private updateActiveCue(): void {
    if (!this.settings.enabled || !this.videoEl || this.flatCues.length === 0) {
      this.onCueChange(null);
      return;
    }
    const nowMs = this.videoEl.currentTime * 1000;
    const cue = findCueAtTime(this.flatCues, nowMs);
    this.onCueChange(cue);
  }

  private emitStatus(patch: Partial<RuntimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      provider: this.settings.provider,
      mode: this.settings.mode,
    };
    this.onStatusChange({ ...this.status });
  }

  private callBridge<T>(payload: Record<string, unknown>, timeoutMs = 4500): Promise<T | null> {
    return new Promise((resolve) => {
      const requestId = `sf-req-${++this.bridgeReqCounter}-${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingBridgeRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pendingBridgeRequests.set(requestId, (data) => {
        clearTimeout(timer);
        resolve(data as T);
      });

      window.postMessage(
        {
          source: 'SUBFLOW_CONTENT',
          requestId,
          ...payload,
        },
        '*',
      );
    });
  }

  private async requestPlayerTracks(): Promise<BridgePlayerTracksResult | null> {
    return this.callBridge<BridgePlayerTracksResult>({ type: 'GET_PLAYER_TRACKS' }, 2000);
  }

  private async requestTrackBody(
    videoId: string,
    baseUrl: string,
    languageCode: string,
  ): Promise<string> {
    const res = await this.callBridge<{ body?: string }>(
      {
        type: 'FETCH_TRACK',
        videoId,
        baseUrl,
        languageCode,
      },
      6000,
    );
    return res?.body ?? '';
  }

  public isAiRunning(): boolean {
    return this.aiRunning;
  }
}
