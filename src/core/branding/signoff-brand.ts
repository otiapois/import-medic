import { z } from 'zod';
import { escapeReportText } from '../report-html';
import { profileText } from '../shopify-price-diff/settings-validation';

export const SIGNOFF_ACCENTS = Object.freeze({
  forest: Object.freeze({ label: 'Forest', background: '#1b432e', foreground: '#ffffff' }),
  navy: Object.freeze({ label: 'Navy', background: '#1a365d', foreground: '#ffffff' }),
  slate: Object.freeze({ label: 'Slate', background: '#334155', foreground: '#ffffff' }),
  burgundy: Object.freeze({ label: 'Burgundy', background: '#69223e', foreground: '#ffffff' }),
} as const);

export const signoffBrandSchema = z.strictObject({
  agencyName: profileText(120),
  preparedFor: z.union([z.literal(''), profileText(120)]),
  contactNote: z.union([z.literal(''), profileText(240)]),
  accentKey: z.enum(['forest', 'navy', 'slate', 'burgundy']),
});

export type SignoffBrand = z.infer<typeof signoffBrandSchema>;

/** Add a header to an existing, trusted ImportMedic offline report template. */
export function brandSignoffHtml(html: string, branding?: SignoffBrand): string {
  if (branding === undefined) return html;
  const { agencyName, preparedFor, contactNote, accentKey } = signoffBrandSchema.parse(branding);
  const { background, foreground } = SIGNOFF_ACCENTS[accentKey];
  const header = '<aside class="signoff-brand" aria-label="Agency branding" style="box-sizing:border-box;max-width:1120px;' +
    'margin:0 auto 1rem;padding:.75rem 1rem;border-radius:.5rem;overflow-wrap:anywhere;white-space:pre-wrap;' +
    'print-color-adjust:exact;background:' + background + ';color:' + foreground + '">' +
    '<div>Prepared by <strong>' + escapeReportText(agencyName) + '</strong></div>' +
    (preparedFor ? '<div>Prepared for <strong>' + escapeReportText(preparedFor) + '</strong></div>' : '') +
    (contactNote ? '<div>' + escapeReportText(contactNote) + '</div>' : '') + '</aside>';
  return html.replace('<body>', () => '<body>' + header);
}
