export const offlineReportCsp = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeReportText = (value: string): string => value.replace(/[&<>"']/g, (character) => entities[character])
  .replace(/\b(https?|ftp|data|file|javascript|vbscript|blob):(?:\/\/)?|\/\//gi, (start) => start === '//' ? '&#47;/' : start.replace(':', '&#58;'));

export function custodyFooter(entries: readonly (readonly [label: string, digest: string | undefined])[]): string {
  const rows = entries.flatMap(([label, digest]) => digest ? [
    '<dt>' + escapeReportText(label) + '</dt><dd><code>' + escapeReportText(digest) + '</code></dd>',
  ] : []);
  return '<footer><h2>SHA-256 chain of custody</h2><dl>' + rows.join('') + '</dl></footer>';
}
