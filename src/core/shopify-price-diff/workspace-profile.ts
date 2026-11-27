import { z } from 'zod';
import { hasDuplicateKeys, profileText, thresholds } from './settings-validation';
import { currencyCode, tieredSettingsSchema } from './pricing-rules';
import type { RecipeResult } from './recipe';

export type { StorePlatform } from './types';
export const MAX_WORKSPACE_PROFILE_BYTES = 64 * 1024;

const workspaceSchema = z.strictObject({
  version: z.literal(1),
  storeName: profileText(120),
  platform: z.enum(['shopify', 'woocommerce', 'bigcommerce']),
  storeCurrency: currencyCode,
  dropThresholdPercent: thresholds(100).optional(),
  increaseThresholdPercent: thresholds(100_000).optional(),
  inventoryDropThresholdPercent: thresholds(100).optional(),
  pricingRule: tieredSettingsSchema.optional(),
});

export type WorkspaceProfile = z.infer<typeof workspaceSchema>;

const failure = (code: string, message: string): RecipeResult<never> => ({ ok: false, diagnostics: [{ code, message }] });

export function createWorkspaceProfile(input: unknown): RecipeResult<WorkspaceProfile> {
  const profile = workspaceSchema.safeParse(input);
  if (profile.success) return { ok: true, value: profile.data };
  return { ok: false, diagnostics: profile.error.issues.map(({ path, message }) => {
    const field = path.join('.');
    return { code: 'invalid-workspace-profile', field, message: field ? field + ' - ' + message : message };
  }) };
}

export function parseWorkspaceProfile(bytes: Uint8Array): RecipeResult<WorkspaceProfile> {
  if (bytes.byteLength > MAX_WORKSPACE_PROFILE_BYTES) return failure('workspace-profile-too-large', 'Choose a workspace profile smaller than 64 KB.');
  let json: string;
  let value: unknown;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    return failure('invalid-workspace-profile-json', 'This file is not valid UTF-8 workspace profile JSON.');
  }
  if (hasDuplicateKeys(json)) return failure('duplicate-workspace-profile-property', 'Each workspace profile property must occur exactly once.');
  return createWorkspaceProfile(value);
}

export const serializeWorkspaceProfile = (profile: WorkspaceProfile): string => JSON.stringify(profile, null, 2) + '\n';
