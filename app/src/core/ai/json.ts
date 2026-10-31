// Models wrap JSON in prose or code fences, or cut it off. Pull out the first complete JSON value we can.

/** Parses the first JSON object or array in `text`; undefined when there is none. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to scanning
  }
  for (let start = 0; start < cleaned.length; start++) {
    const ch = cleaned[start];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchingEnd(cleaned, start);
    if (end < 0) continue;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

function matchingEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
