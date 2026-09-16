/** Strip code fences / prose and parse the first JSON value found. */
export function parseJson<T = any>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  return JSON.parse(s) as T;
}

/**
 * Recover a top-level JSON array from output that may have been wrapped in an envelope.  Some
 * providers (and some models) ignore "return a JSON array" and hand back an object whose array
 * rides inside it — a strict top-level `Array.isArray` check then misses the content.
 *
 * Returns the array when one of these holds:
 *  1. The value is a bare array.
 *  2. The value is an object with a key in `preferredKeys` whose value is an array.
 *  3. The value is an object with exactly one key whose value is an array.
 *
 * Returns `undefined` otherwise so the caller retains its own "no result" policy (throw
 * NoTestCasesError, fall back to `[]`, retry — whatever fits the stage).
 */
export function unwrapArray(
  value: unknown,
  preferredKeys: readonly string[],
): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of preferredKeys) {
      if (key in obj && Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    const keys = Object.keys(obj);
    if (keys.length === 1 && Array.isArray(obj[keys[0]])) return obj[keys[0]] as unknown[];
  }
  return undefined;
}
