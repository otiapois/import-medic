import { z } from 'zod';
import { validThreshold } from './mapping';

const unsafeText = /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069\uFEFF\uD800-\uDFFF]/u;
export const profileText = (maximum: number) => z.string().max(maximum).refine((value) => value.trim() !== '' && !unsafeText.test(value), 'Use non-blank text without control or direction override characters.');
export const thresholds = (maximum: number) => z.number().refine((value) => validThreshold(value, maximum), `Use a percentage from 0 to ${maximum} with at most three decimal places.`);

// JSON.parse validates syntax first. Scan only object key tokens so duplicate
// properties cannot silently override earlier fields, including escaped keys.
export function hasDuplicateKeys(json: string): boolean {
  const objects: Set<string>[] = [];
  for (const token of json.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}]/g)) {
    const [text] = token;
    if (text === '{') objects.push(new Set());
    else if (text === '}') objects.pop();
    else if (/^\s*:/.test(json.slice(token.index + text.length))) {
      const key = JSON.parse(text) as string;
      const object = objects.at(-1)!;
      if (object.has(key)) return true;
      object.add(key);
    }
  }
  return false;
}
