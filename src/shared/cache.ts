import type { SubtitleCue, SubtitleMode, AiProvider } from './types';

const DB_NAME = 'subflow_subtitle_cache_v1';
const STORE_NAME = 'chunks';
const DB_VERSION = 1;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

interface CacheRecord {
  key: string;
  cues: SubtitleCue[];
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

export function buildChunkCacheKey(params: {
  videoId: string;
  sourceLang: string;
  mode: SubtitleMode;
  targetLang: string;
  provider: AiProvider;
  model: string;
  chunkIndex: number;
}): string {
  const effectiveLang = params.mode === 'original' ? 'orig' : params.targetLang;
  return [
    params.videoId,
    params.sourceLang,
    params.mode,
    effectiveLang,
    params.provider,
    params.model || 'default',
    `c${params.chunkIndex}`,
  ].join('::');
}

export async function getCachedChunk(key: string): Promise<SubtitleCue[] | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const record = req.result as CacheRecord | undefined;
        if (!record) {
          resolve(null);
          return;
        }
        if (Date.now() - record.updatedAt > CACHE_TTL_MS) {
          resolve(null);
          return;
        }
        resolve(record.cues);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedChunk(key: string, cues: SubtitleCue[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: CacheRecord = {
        key,
        cues,
        updatedAt: Date.now(),
      };
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Non-fatal cache write error
  }
}

export async function clearAllCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Non-fatal
  }
}
