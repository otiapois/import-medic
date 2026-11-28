import type { DetectedEncoding } from '../../core/types';

export const CSV_ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'windows-1252': 'Windows-1252',
  'utf-16le': 'UTF-16LE',
  unknown: 'Unknown encoding',
} as const satisfies Record<DetectedEncoding, string>;
