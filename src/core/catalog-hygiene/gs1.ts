export interface GtinCheck {
  valid: boolean;
  expectedCheckDigit: string | null;
  suppliedCheckDigit: string | null;
}

const gtin = /^(?:[0-9]{8}|[0-9]{12,14})(?![\s\S])/;

/** GS1 Mod 10. The payload and its check digit stay strings. */
export function validateGtin(value: unknown): GtinCheck {
  if (typeof value !== 'string' || !gtin.test(value)) return { valid: false, expectedCheckDigit: null, suppliedCheckDigit: null };
  let sum = 0;
  let weight = 3;
  for (let index = value.length - 2; index >= 0; index--) {
    sum += (value.charCodeAt(index) - 48) * weight;
    weight = 4 - weight;
  }
  const expectedCheckDigit = String((10 - sum % 10) % 10);
  const suppliedCheckDigit = value.slice(-1);
  return { valid: suppliedCheckDigit === expectedCheckDigit, expectedCheckDigit, suppliedCheckDigit };
}
