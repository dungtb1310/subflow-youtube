import { DEFAULT_SETTINGS, LEGACY_STORAGE_KEY, STORAGE_KEY } from './constants';
import type { SubFlowSettings } from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSettings(raw?: Partial<SubFlowSettings> | null): SubFlowSettings {
  const merged: SubFlowSettings = {
    ...DEFAULT_SETTINGS,
    ...(raw ?? {}),
  };
  merged.fontSize = clamp(Number(merged.fontSize) || DEFAULT_SETTINGS.fontSize, 14, 40);
  merged.bgOpacity = clamp(
    Number.isFinite(Number(merged.bgOpacity)) ? Number(merged.bgOpacity) : DEFAULT_SETTINGS.bgOpacity,
    0,
    0.96,
  );
  merged.bottomOffsetPercent = clamp(
    Number.isFinite(Number(merged.bottomOffsetPercent))
      ? Number(merged.bottomOffsetPercent)
      : DEFAULT_SETTINGS.bottomOffsetPercent,
    2,
    80,
  );
  merged.ollamaUrl = (merged.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).trim().replace(/\/+$/, '');
  merged.openaiBaseUrl = (merged.openaiBaseUrl || DEFAULT_SETTINGS.openaiBaseUrl)
    .trim()
    .replace(/\/+$/, '');
  return merged;
}

export async function loadSettings(): Promise<SubFlowSettings> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ...DEFAULT_SETTINGS };
  }
  const data = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  const stored = (data[STORAGE_KEY] ?? data[LEGACY_STORAGE_KEY]) as
    | Partial<SubFlowSettings>
    | undefined;
  return normalizeSettings(stored);
}

let writeChain: Promise<SubFlowSettings> = Promise.resolve({ ...DEFAULT_SETTINGS });

export function saveSettings(patch: Partial<SubFlowSettings>): Promise<SubFlowSettings> {
  writeChain = writeChain.then(async () => {
    const current = await loadSettings();
    const next = normalizeSettings({ ...current, ...patch });
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
    }
    return next;
  });
  return writeChain;
}

export function subscribeSettings(listener: (settings: SubFlowSettings) => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return () => {};
  }
  const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) {
      return;
    }
    listener(normalizeSettings(changes[STORAGE_KEY].newValue as Partial<SubFlowSettings>));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
