/**
 * Parses JSON out of model text. JSON mode usually returns an object already;
 * chat-completions models return a string that may carry ```json fences or
 * surrounding prose. Returns undefined when nothing parses — the caller
 * (`generateJson`) checks the value against the schema either way.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1], trimmed].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const body = candidate.trim();
    try {
      return JSON.parse(body);
    } catch {
      const start = body.search(/[[{]/);
      const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1));
        } catch {
          // try the next candidate
        }
      }
    }
  }
  return undefined;
}
