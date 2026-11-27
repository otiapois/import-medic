import Papa from 'papaparse';
import { z } from 'zod';
import type { DetectedEncoding, DetectedLineEnding } from './types';

export interface CsvRecord {
  line: number;
  raw: string;
  cells: string[];
  parseError?: string;
}

const rowSchema = z.array(z.string());

export function decodeCsv(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const utf16leBom = bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16beBom = bytes[0] === 0xfe && bytes[1] === 0xff;
  const utf32leBom = utf16leBom && bytes[2] === 0 && bytes[3] === 0;
  const encoding = utf16leBom ? 'utf-16le' : utf8Bom ? 'utf-8-bom' : 'utf-8';
  if (utf16beBom || utf32leBom) return { text: '', encoding: 'unknown' };

  try {
    const text = new TextDecoder(utf16leBom ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? { text: '', encoding: 'unknown' } : { text, encoding };
  } catch {
    if (utf8Bom || utf16leBom || bytes.includes(0)) return { text: '', encoding: 'unknown' };
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

export function parseCsv(text: string): { records: CsvRecord[]; lineEnding: DetectedLineEnding } {
  const endings = [...text.matchAll(/\r\n|\n|\r/g)];
  const kinds = new Set<string>();
  const normalized = text.replace(/\r\n|\r/g, '\n');
  const records: CsvRecord[] = [];
  let cursor = 0;
  let rawCursor = 0;
  let endingIndex = 0;

  Papa.parse<string[]>(normalized, {
    delimiter: ',',
    newline: '\n',
    dynamicTyping: false,
    step({ data, errors, meta }) {
      const line = endingIndex + 1;
      const span = normalized.slice(cursor, meta.cursor);
      if (span === '') return; // Papa reports an empty phantom row after the final record separator.

      // Papa's cursor defines record boundaries. Rehydrate the physical line endings
      // inside its cells so a mixed-ending file retains the original cell content.
      const embeddedStart = endingIndex;
      endingIndex += (span.match(/\n/g) ?? []).length;
      let embeddedIndex = embeddedStart;
      const cells = rowSchema.parse(data).map((value) =>
        value.replace(/\n/g, () => endings[embeddedIndex++][0]),
      );
      const lastEnding = endings[endingIndex - 1];
      const terminated = span.endsWith('\n') && !errors.some(({ code }) => code === 'MissingQuotes');
      if (terminated) kinds.add(lastEnding[0]);
      const rawEnd = terminated ? lastEnding.index : text.length;
      records.push({
        line,
        raw: text.slice(rawCursor, rawEnd),
        cells,
        ...(errors.length > 0 ? { parseError: [...new Set(errors.map(({ message }) => message))].join('. ') } : {}),
      });
      cursor = meta.cursor;
      rawCursor = terminated ? lastEnding.index + lastEnding[0].length : rawEnd;
    },
  });
  const lineEnding = kinds.size > 1 || kinds.has('\r') ? 'mixed' : kinds.has('\r\n') ? 'crlf' : 'lf';
  return { records, lineEnding };
}

export function serializeCsv(headers: readonly string[], rows: readonly (readonly string[])[], platform: string): string {
  return serializeCsvRecords([headers, ...rows], platform);
}

export function serializeCsvRecords(records: readonly (readonly string[])[], platform: string): string {
  return Papa.unparse(records.map((row) => Array.from(row)), {
    delimiter: ',',
    newline: platform === 'shopify-products' ? '\n' : '\r\n',
    // Leave content intact, including leading minus signs on bank amounts.
    escapeFormulae: false,
  });
}
