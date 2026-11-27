import { z } from 'zod';
import source from '../../../docs/error-catalog.json';

const text = z.string().trim().min(1);
const example = z.string().refine((value) => value.trim().length > 0);

const catalog = z.object({
  schemaVersion: z.literal(1),
  errors: z.array(z.object({
    code: text,
    platform: z.enum(['shopify-products', 'quickbooks-bank', 'stripe-paypal']),
    title: text,
    symptom: text,
    trigger: text,
    slug: text.nullable(),
    before: example,
    after: example,
    fixMode: z.enum(['auto', 'conditional', 'manual']),
    faq: z.array(z.object({ question: text, answer: text })).nonempty(),
    sources: z.array(z.object({ title: text, url: z.url({ protocol: /^https$/ }) })).nonempty(),
  })).nonempty(),
});

export const catalogErrors = catalog.parse(source).errors;
export type CatalogError = (typeof catalogErrors)[number];
export type Faq = CatalogError['faq'][number];
