export interface SupplierFingerprint {
  filename: string;
  sha256: string;
  bytes: number;
}

export interface PriceCustody {
  baselineSha256: string;
  suppliers: readonly SupplierFingerprint[];
  updateCsvSha256?: string;
  rollbackCsvSha256?: string;
}

export interface RepairCustody {
  sourceSha256: string;
  repairedCsvSha256?: string;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
