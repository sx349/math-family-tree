/**
 * Safe localStorage access for remembering a control's last value across
 * navigation. Some environments (private browsing, a full quota, storage
 * disabled outright) throw just from touching localStorage, and a
 * preference failing to save should never break the page reading or
 * writing it — so every failure here just falls back to "not remembered".
 */

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do — the preference just won't survive this session.
  }
}
