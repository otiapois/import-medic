const accept = '.csv,.tsv,.txt';

export const AMAZON_FILE_EXTENSION = /\.(csv|tsv|txt)$/i;
export const AMAZON_FILE_ERROR = 'Choose one file with a .csv, .tsv, or .txt extension.';

export const AMAZON_BASELINE_FIELD = {
  title: 'Amazon baseline Price & Quantity',
  formats: 'Drop the original Price & Quantity file (.csv, .tsv, or .txt)',
  label: 'Choose Amazon baseline Price & Quantity file',
  accept,
};

export const AMAZON_PROPOSAL_FIELD = {
  title: 'Amazon proposal',
  formats: 'Drop one proposal file (.csv, .tsv, or .txt)',
  label: 'Choose Amazon proposal file',
  accept,
};

export const AMAZON_VERIFY_FIELDS = {
  baseline: AMAZON_BASELINE_FIELD,
  candidate: {
    title: 'Amazon update or rollback',
    formats: 'Drop the Amazon file you plan to import (.csv, .tsv, or .txt)',
    label: 'Choose Amazon update or rollback file',
    accept,
  },
  pairedUpdate: {
    title: 'Matching Amazon update',
    formats: 'Drop the Amazon update to reverse (.csv, .tsv, or .txt)',
    label: 'Choose matching Amazon update file',
    accept,
  },
};
