import { defineStore } from 'pinia';
import { ref } from 'vue';

const STORAGE_KEY = 'aelvory.curl-history';
const MAX_ENTRIES = 100;

export interface CurlHistoryEntry {
  id: string;
  command: string;
  timestamp: number;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
}

function load(): CurlHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CurlHistoryEntry[];
  } catch {
    /* ignore corrupt storage */
  }
  return [];
}

export const useCurlHistoryStore = defineStore('curlHistory', () => {
  const entries = ref<CurlHistoryEntry[]>(load());

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value));
    } catch {
      /* quota / unavailable */
    }
  }

  function add(entry: Omit<CurlHistoryEntry, 'id' | 'timestamp'>): CurlHistoryEntry {
    const full: CurlHistoryEntry = {
      ...entry,
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
    };
    entries.value = [full, ...entries.value].slice(0, MAX_ENTRIES);
    persist();
    return full;
  }

  function update(id: string, patch: Partial<CurlHistoryEntry>) {
    const idx = entries.value.findIndex((e) => e.id === id);
    if (idx === -1) return;
    entries.value = [
      ...entries.value.slice(0, idx),
      { ...entries.value[idx], ...patch },
      ...entries.value.slice(idx + 1),
    ];
    persist();
  }

  function remove(id: string) {
    entries.value = entries.value.filter((e) => e.id !== id);
    persist();
  }

  function clear() {
    entries.value = [];
    persist();
  }

  return { entries, add, update, remove, clear };
});
