import { isScientific } from '../xlsx';
import { validateGtin } from './gs1';
import { stripZeroWidths, type AddIssue, type CatalogTable } from './source';

interface ShopifyBarcode {
  prefix: string;
  type: string;
  value: string;
}

/** Parse the Shopify list escapes without re-encoding or normalizing the operator's text. */
function shopifyBarcodes(raw: string): ShopifyBarcode[] | null {
  const entries: ShopifyBarcode[] = [];
  let start = 0;
  let colon = -1;
  for (let index = 0; index <= raw.length; index++) {
    const character = raw[index];
    if (character === '\\') {
      if (!['\\', ';', ':'].includes(raw[++index])) return null;
    } else if (character === ':') {
      if (colon !== -1) return null;
      colon = index;
    } else if (character === ';' || index === raw.length) {
      const item = raw.slice(start, index);
      const gap = /^ */.exec(item)![0];
      const prefix = colon === -1 ? gap : raw.slice(start, colon + 1);
      const value = item.slice(prefix.length);
      const type = colon === -1 ? 'untyped' : prefix.slice(gap.length, -1).toLowerCase();
      if (!value || !type || entries.length >= 20) return null;
      entries.push({ prefix, type, value });
      start = index + 1;
      colon = -1;
    }
  }
  return entries;
}

type CheckBarcode = (code: string, message: string, details?: Parameters<AddIssue>[2]) => void;

export function auditBarcode(raw: string, kind: CatalogTable['barcodeKind'], strip: boolean, add: CheckBarcode) {
  const gtins: string[] = [];
  if (!raw) return { after: raw, gtins };
  const tokens = kind === 'shopify-list' ? shopifyBarcodes(raw) : [{ prefix: '', type: kind, value: raw }];
  if (!tokens) {
    add('invalid-barcode-list', 'Use up to 20 nonempty Shopify barcode items separated by semicolons and escape literal backslashes, semicolons and colons.');
    return { after: raw, gtins };
  }
  const after = tokens.map(({ prefix, type, value: original }) => {
    const decode = (value: string) => kind === 'shopify-list' ? value.replace(/\\([\\;:])/g, '$1') : value;
    const literal = decode(original);
    // Preserve non-GS1 typed identifiers. An eight-digit UPC is UPC-E, whose
    // compressed payload is outside the GTIN-8 check-digit algorithm here.
    const isbn = type === 'isbn' || type === 'woo-global';
    const candidate = stripZeroWidths(literal);
    const scoped = ['gtin', 'ean', 'upc', 'single', 'woo-global'].includes(type) ||
      type === 'isbn' && /^(?:978|979)/.test(candidate) || type === 'untyped' && /^(?:[0-9]{8}|[0-9]{12,14})$/.test(candidate);
    const special = (type === 'upc' && /^[0-9]{8}$/.test(candidate)) || (isbn && /^[0-9]{9}[0-9Xx]$/.test(candidate));
    const written = strip && scoped && !special ? stripZeroWidths(original) : original;
    const value = decode(written);
    if (isScientific(candidate)) {
      add('scientific-barcode', 'This barcode resembles spreadsheet scientific notation. Recover the exact original identifier.', { value });
    } else if (special || !scoped) {
      add('barcode-outside-gs1-scope', 'This barcode type is preserved outside the GS1 Mod 10 check.', { level: 'warning', value });
    } else if (value !== '') {
      const lengthValid = type === 'ean' ? value.length === 8 || value.length === 13 :
        type === 'upc' ? value.length === 12 : type === 'isbn' ? value.length === 13 : true;
      const { valid, expectedCheckDigit, suppliedCheckDigit } = validateGtin(value);
      if (!lengthValid || expectedCheckDigit === null || suppliedCheckDigit === null) {
        add('invalid-gtin-format', 'Enter the exact ASCII digits of a supported GS1 identifier for this barcode type.', { value });
      } else if (!valid) {
        add('invalid-gtin-check-digit', 'The supplied check digit disagrees with GS1 Mod 10.', { value, expectedCheckDigit, suppliedCheckDigit });
      } else gtins.push(value);
    } else add('invalid-gtin-format', 'The barcode cannot become empty through cleanup.', { value });
    return prefix + written;
  }).join(';');
  return { after, gtins };
}
