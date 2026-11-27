import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { SourceCell, SourceRow } from './types';

interface Relationship { '@_Id'?: string; '@_Type'?: string; '@_Target'?: string; '@_TargetMode'?: string }
interface WorkbookSheet { '@_name'?: string; '@_id'?: string }
type TextNode = string | { '#text'?: string };
interface XmlString { t?: TextNode; r?: { t?: TextNode }[] }
interface XmlCell { '@_r'?: string; '@_t'?: string; '@_s'?: string; v?: string; is?: XmlString; f?: TextNode }
interface XmlRow { '@_r'?: string; c?: XmlCell[] }
interface XmlDocument {
  workbook?: { sheets?: { sheet?: WorkbookSheet[] } };
  Relationships?: { Relationship?: Relationship[] };
  sst?: { si?: XmlString[] };
  styleSheet?: { numFmts?: { numFmt?: { '@_numFmtId': string; '@_formatCode': string }[] }; cellXfs?: { xf?: { '@_numFmtId': string }[] } };
  worksheet?: { sheetData?: { row?: XmlRow[] } };
}

const entriesAsArrays = new Set(['Relationship', 'sheet', 'si', 'r', 'row', 'c', 'numFmt', 'xf']);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
  maxNestedTags: 64,
  isArray: (name) => entriesAsArrays.has(name),
});

const invalid = (): never => { throw new Error('invalid-xlsx'); };
const archiveSizeLimit = 16 * 1024 * 1024;
const expandedSizeLimit = 64 * 1024 * 1024;
const maxEntries = 512;
const maxSheets = 32;
const maxColumns = 16_384;
const maxRows = 1_048_576;
const maxCells = 400_000;
const relationPrefix = /^(?:http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships|http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships)\//;
const validPath = /^(?:[A-Za-z0-9_.[\]-]+\/)*[A-Za-z0-9_.[\]-]+\/?$/;

function unzipWorkbook(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length < 22 || bytes.length > archiveSizeLimit || bytes[0] !== 0x50 || bytes[1] !== 0x4b) invalid();
  const names = new Set<string>();
  let expandedSize = 0;
  return unzipSync(bytes, { filter({ name, size, originalSize, compression }) {
    const key = name.toLowerCase();
    expandedSize += originalSize;
    if (!validPath.test(name) || name.split('/').some((part) => part === '.' || part === '..') || names.has(key) ||
      names.size >= maxEntries || expandedSize > expandedSizeLimit || size > bytes.length ||
      (compression !== 0 && compression !== 8) || (compression === 0 && size !== originalSize) ||
      key.endsWith('vbaproject.bin')) invalid();
    names.add(key);
    return /\.(?:xml|rels)$/i.test(name);
  } });
}

function partTarget(parent: string, target: string): string {
  if (!validPath.test(target.replace(/^\//, '')) || target.endsWith('/')) invalid();
  const parts = target.startsWith('/') ? [] : parent.split('/').slice(0, -1);
  for (const step of target.replace(/^\//, '').split('/')) {
    if (step === '..') {
      if (!parts.length) invalid();
      parts.pop();
    } else if (step !== '.') parts.push(step);
  }
  return parts.join('/');
}

function readLinks(relationships: Relationship[]): Map<string, { type: string; target: string }> {
  const links = new Map<string, { type: string; target: string }>();
  for (const relationship of relationships) {
    const { '@_Id': id, '@_Type': type, '@_Target': target, '@_TargetMode': mode } = relationship;
    if ((mode !== undefined && mode !== 'Internal') || (target && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) ||
      (type && /\/externalLink(?:Path)?$/i.test(type))) {
      throw new Error('external-xlsx-relationship');
    }
    if (!id || !type || !target || links.has(id)) return invalid();
    links.set(id, { type: type.replace(relationPrefix, ''), target });
  }
  return links;
}

const textNode = (node: TextNode | undefined): string => {
  const text = typeof node === 'string' ? node : node?.['#text'] ?? '';
  return typeof text === 'string' ? text : invalid();
};
const spreadsheetText = (source: XmlString | undefined): string =>
  (source?.r ? source.r.map((part) => textNode(part.t)).join('') : textNode(source?.t))
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const scientificValue = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[Ee][+-]?[0-9]+$/;
export const isScientific = (value: string): boolean => scientificValue.test(value.trim());

function workbookCell(
  cell: XmlCell, strings: readonly string[], formats: readonly string[],
): SourceCell {
  const { '@_t': type, '@_s': style, v, is, f } = cell;
  if (v !== undefined && typeof v !== 'string') return invalid();
  const stored = v ?? null;
  if (f !== undefined) return { value: stored, kind: 'formula', formula: textNode(f) };
  if (type === 's') {
    const index = stored && /^\d+$/.test(stored) ? Number(stored) : -1;
    const text = strings[index];
    return text === undefined ? invalid() : { value: text, kind: 'text' };
  }
  if (type === 'inlineStr') return { value: spreadsheetText(is), kind: 'text' };
  if (type === 'str') return { value: stored, kind: 'text' };
  if (type !== undefined && type !== 'n') return { value: stored, kind: 'unsupported' };
  if (stored === null) return { value: null, kind: 'missing' };
  const format = formats[Number(style ?? '0')] ?? '';
  const scientific = isScientific(stored) || /[eE][+-]0/.test(format);
  const currency = /\[\$([A-Z]{3}|[$€£¥₹])(?:-[^\]]+)?\]/.exec(format)?.[1] ??
    /"([A-Z]{3})"/.exec(format)?.[1] ?? /[$€£¥₹]/.exec(format.replace(/\[\$-[^\]]+\]/g, ''))?.[0];
  const formatTokens = format.replace(/\[[^\]]*]|"[^"]*"|\\./g, '');
  if (/%|[ymdhs]/i.test(formatTokens) && !scientific) return { value: stored, kind: 'unsupported' };
  return { value: stored, kind: 'number', ...(scientific ? { scientific } : {}), ...(currency ? { currency } : {}) };
}

function formatCodes(styles: XmlDocument['styleSheet']): string[] {
  const formats = new Map(styles?.numFmts?.numFmt?.map((entry) => [entry['@_numFmtId'], entry['@_formatCode']]));
  return (styles?.cellXfs?.xf ?? []).map((style) => {
    const raw = style['@_numFmtId'];
    const custom = formats.get(raw);
    if (custom !== undefined) return custom;
    const id = Number(raw);
    if ((id >= 5 && id <= 8) || id === 42 || id === 44) return '$0.00';
    if (id === 9 || id === 10) return '0%';
    if (id === 11 || id === 48) return '0.00E+00';
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return 'yyyy-mm-dd';
    return '';
  });
}

export function readWorkbook(bytes: Uint8Array): { name: string; rows: SourceRow[] }[] {
  const entries = unzipWorkbook(bytes);
  const xml = new Map<string, string>();
  for (const [part, data] of Object.entries(entries)) {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
    const content = new TextDecoder(encoding, { fatal: true }).decode(data);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content) || content.includes('\0')) invalid();
    xml.set(part, content);
  }
  const parts = xml.get('[Content_Types].xml');
  if (!parts || /macroenabled/i.test(parts)) return invalid();
  const readXml = (part: string): XmlDocument => {
    const content = xml.get(part);
    if (!content || XMLValidator.validate(content) !== true) return invalid();
    return xmlParser.parse(content) as XmlDocument;
  };

  const relations = new Map<string, ReturnType<typeof readLinks>>();
  for (const part of xml.keys()) {
    if (!/\.rels$/i.test(part)) continue;
    const root = readXml(part).Relationships;
    if (root === undefined) invalid();
    relations.set(part, readLinks(root?.Relationship ?? []));
  }

  const rootLinks = [...relations.get('_rels/.rels')?.values() ?? []].filter(({ type }) => type === 'officeDocument');
  if (rootLinks.length !== 1) return invalid();
  const workbookPart = partTarget('', rootLinks[0].target);
  const workbookDir = workbookPart.split('/').slice(0, -1);
  const workbookFile = workbookPart.split('/').at(-1)!;
  const workbookLinks = relations.get([...workbookDir, '_rels', workbookFile + '.rels'].join('/'));
  const sheets = readXml(workbookPart).workbook?.sheets?.sheet;
  if (!sheets?.length || sheets.length > maxSheets || !workbookLinks) return invalid();

  const part = (type: string) => {
    const matches = [...workbookLinks.values()].filter((link) => link.type === type);
    if (matches.length > 1) invalid();
    return matches[0] ? readXml(partTarget(workbookPart, matches[0].target)) : undefined;
  };
  const strings = part('sharedStrings')?.sst?.si?.map(spreadsheetText) ?? [];
  const formats = formatCodes(part('styles')?.styleSheet);
  const sheetNames = new Set<string>();
  const sheetPaths = new Set<string>();
  const result: { name: string; rows: SourceRow[] }[] = [];
  let cellCount = 0;
  for (const sheet of sheets) {
    const { '@_name': name, '@_id': id } = sheet;
    const link = id && workbookLinks.get(id);
    if (!name || !link || sheetNames.has(name.toLowerCase())) return invalid();
    sheetNames.add(name.toLowerCase());
    if (link.type === 'chartsheet') continue;
    if (link.type !== 'worksheet') return invalid();
    const path = partTarget(workbookPart, link.target);
    if (sheetPaths.has(path)) invalid();
    sheetPaths.add(path);
    const worksheet = readXml(path).worksheet;
    if (worksheet === undefined) return invalid();

    const rows: SourceRow[] = [];
    let previousLine = 0;
    for (const xmlRow of worksheet.sheetData?.row ?? []) {
      const firstAddress = xmlRow.c?.[0]?.['@_r'];
      const rowNumber = xmlRow['@_r'] ?? (firstAddress && /^[A-Z]+([0-9]+)$/.exec(firstAddress)?.[1]);
      const line = rowNumber ? Number(rowNumber) : previousLine + 1;
      if ((rowNumber && !/^[1-9]\d*$/.test(rowNumber)) || !Number.isSafeInteger(line) || line <= previousLine || line > maxRows) invalid();
      previousLine = line;
      const cells: SourceCell[] = [];
      for (const cell of xmlRow.c ?? []) {
        cellCount++;
        if (cellCount > maxCells) invalid();
        const ref = cell['@_r'];
        const address = ref === undefined ? undefined : /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
        if (ref !== undefined && (!address || Number(address[2]) !== line)) invalid();
        let column = cells.length;
        if (address) {
          column = 0;
          for (const character of address[1]) column = column * 26 + character.charCodeAt(0) - 64;
          column--;
        }
        if (column >= maxColumns || cells[column]) invalid();
        cells[column] = workbookCell(cell, strings, formats);
      }
      while (cells.length && cells.at(-1)?.kind === 'missing') cells.pop();
      if (cells.some((cell) => cell.kind === 'formula' || cell.kind === 'unsupported' || (cell.value !== null && cell.value !== ''))) {
        rows.push({ line, cells });
      }
    }
    result.push({ name, rows });
  }
  return result.length ? result : invalid();
}
