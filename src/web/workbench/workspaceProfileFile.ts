import { MAX_WORKSPACE_PROFILE_BYTES, parseWorkspaceProfile } from '../../core/shopify-price-diff/workspace-profile';

export async function readWorkspaceProfileFile(file: File) {
  if (file.size > MAX_WORKSPACE_PROFILE_BYTES) {
    throw new Error('The workspace profile file is too large. Choose a saved workspace profile JSON file.');
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error('The local workspace profile could not be read.');
  }
  const result = parseWorkspaceProfile(new Uint8Array(bytes));
  if (!result.ok) throw new Error(result.diagnostics.map(({ message }) => message).join(' '));
  return result.value;
}
