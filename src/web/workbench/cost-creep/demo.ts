const COSTS = [
  ['00101', '10', '10.40', '10.82', '11.26', '16'],
  ['00102', '20', '20.80', '21.63', '22.50', '32'],
  ['00103', '5', '5.25', '5.52', '5.80', '10'],
  ['00104', '12', '12.25', '12.20', '12.30', '20'],
  ['00105', '8', '', '8.40', '8.80', '15'],
  ['00106', '15', '14', '13', '', '25'],
  ['00107', '', '6', '6', '6.12', '11'],
] as const;

function demoFile(column: number, filename: string, header: string) {
  const rows = COSTS.flatMap((row) => row[column] ? [`${row[0]},${row[column]}`] : []);
  return new File([[`SKU,${header}`, ...rows, ''].join('\r\n')], filename, { type: 'text/csv' });
}

export function costCreepDemo() {
  return {
    periods: [1, 2, 3, 4].map((quarter) => ({
      label: `Q${quarter}`,
      file: demoFile(quarter, `synthetic-cost-creep-q${quarter}.csv`, 'Cost'),
    })),
    retail: demoFile(5, 'synthetic-cost-creep-store-baseline.csv', 'Retail Price'),
  };
}
