import workbook from '../../../../fixtures/supplier-delta/synthetic-pricebook.xlsx?url&inline';

export function supplierDeltaDemo() {
  const bytes = Uint8Array.from(atob(workbook.slice(workbook.indexOf(',') + 1)), (character) => character.charCodeAt(0));
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return {
    previous: { file: new File([bytes], 'synthetic-previous-pricebook.xlsx', { type }), sheetName: 'Q3_Prices' },
    next: { file: new File([bytes], 'synthetic-new-pricebook.xlsx', { type }), sheetName: 'Q4_Prices' },
  };
}
