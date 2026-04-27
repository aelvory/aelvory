import { dispatchLocal, LocalApiError } from '@/localdb/handlers';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  skipAuth?: boolean;
}

/**
 * Observers notified after every successful local mutation. The sync
 * scheduler subscribes to this to debounce auto-sync on writes. Kept
 * here (not in a store) so the data layer stays free of Pinia imports.
 */
type WriteListener = (path: string, method: string) => void;
const writeListeners = new Set<WriteListener>();
export function onLocalWrite(fn: WriteListener): () => void {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * All `/api/*` calls are dispatched to the local SQLite handler.
 * The remote sync server is reserved for the optional sync flow and is
 * never reached via this function.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  try {
    const result = await dispatchLocal<T>(path, method, opts.body);
    if (MUTATING_METHODS.has(method)) {
      // Skip auth/me-style endpoints if any are added later — for now all
      // /api/* mutations represent user data worth syncing.
      for (const fn of writeListeners) {
        try {
          fn(path, method);
        } catch {
          /* listener errors must not break the API call */
        }
      }
    }
    return result;
  } catch (err) {
    if (err instanceof LocalApiError) {
      throw new ApiError(err.status, { error: err.error }, err.message);
    }
    throw err;
  }
}

export const apiBaseUrl = BASE_URL;
