export function catalogCellEvidence(value: string): string {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
    const hex = character.codePointAt(0)!.toString(16).toUpperCase();
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}
