// Stable JSON (sorted keys, undefined fields left out): equal data gives equal text whatever the key order.

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** The record's content without its stamps (createdAt, updatedAt). */
export function contentOf(record: object): string {
  const { createdAt: _c, updatedAt: _u, ...rest } = record as Record<string, unknown>;
  return stableStringify(rest);
}

/** Same content, whatever the stamps say (a save that changes nothing is not an edit). */
export const sameContent = (a: object | undefined, b: object | undefined): boolean =>
  Boolean(a && b) && contentOf(a!) === contentOf(b!);
