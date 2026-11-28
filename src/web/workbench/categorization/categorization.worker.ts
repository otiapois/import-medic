import { categorizeTransactions } from '../../../core/accounting/categorization-rules';
import type { CategorizationResult } from '../../../core/accounting/categorization-rules';
import type { SignoffBrand } from '../../../core/branding/signoff-brand';
import type { SourceFile } from '../../Workbench';

export interface CategorizationJob {
  source: SourceFile;
  rulePack: { filename: string; bytes: Uint8Array };
  sourceCurrency?: string;
  creditDebitConvention?: 'bank' | 'intuit';
  branding?: SignoffBrand;
}

type Artifacts = CategorizationResult['artifacts'];
export type CategorizationArtifact = keyof Artifacts;
export type CategorizationPreview = Omit<CategorizationResult, 'artifacts' | 'rows'> & {
  artifacts: { [Key in CategorizationArtifact]: ArrayBuffer | null };
};
export type CategorizationReply = { result: CategorizationPreview } | { error: string };

const scope = self as unknown as {
  onmessage: (event: MessageEvent<CategorizationJob>) => void;
  postMessage: (reply: CategorizationReply, transfer?: Transferable[]) => void;
};

scope.onmessage = ({ data: { source, ...options } }) => {
  void (async () => {
    try {
      const bytes = source.sample ? source.bytes : new Uint8Array(await source.file.arrayBuffer());
      const { artifacts, status, issues, metrics, accountSummary, currencyTotals, encoding, custody } =
        await categorizeTransactions({ ...options, csv: { filename: source.filename, bytes } });
      const encoder = new TextEncoder();
      const files = {
        categorizedCsv: artifacts.categorizedCsv && new Uint8Array(artifacts.categorizedCsv).buffer,
        accountSummaryCsv: artifacts.accountSummaryCsv && new Uint8Array(artifacts.accountSummaryCsv).buffer,
        auditJson: encoder.encode(artifacts.auditJson).buffer,
        signoffHtml: artifacts.signoffHtml === null ? null : encoder.encode(artifacts.signoffHtml).buffer,
      };
      scope.postMessage({ result: { status, issues, metrics, accountSummary, currencyTotals, encoding, custody, artifacts: files } },
        Object.values(files).filter((file) => file !== null));
    } catch (error) {
      scope.postMessage({ error: error instanceof Error ? error.message : 'The local categorization could not finish.' });
    }
  })();
};
