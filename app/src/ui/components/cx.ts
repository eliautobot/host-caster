type ClassValue = string | number | bigint | boolean | null | undefined;

/** Joins class names, skipping falsy and non-string values. */
export function cx(...parts: ClassValue[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}
