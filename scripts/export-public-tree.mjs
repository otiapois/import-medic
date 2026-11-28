import { execFileSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const required = [
  '.github/workflows/ci.yml', 'CHANGELOG.md', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'docs/error-catalog.json', 'index.html', 'package.json', 'package-lock.json', 'playwright.config.ts',
  'public/_headers', 'scripts/export-public-tree.mjs', 'scripts/prerender.mjs', 'scripts/repair-cli.ts',
  'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
];
const publicFiles = new Set([
  ...required, '.gitignore', 'fixtures/.gitattributes', 'fixtures/shopify-price-diff/.gitattributes',
]);
const publicTrees = [
  ['src/', /\.(?:ts|tsx|css|json)$/],
  ['fixtures/amazon/', /\.tsv$/],
  ['fixtures/', /\.(?:csv|xlsx|json)$/],
  ['tests/', /\.(?:ts|tsx|csv|xlsx|json)$/],
  ['docs/subsystems/', /\.md$/],
  ['docs/reports/screenshots/', /\.png$/],
];
const localName = /(?:^|[._-])(?:research|internal|private|scratch|local|tmp|temp|cache|draft|backup|secrets?)(?:$|[._-])/i;

function isPublicPath(path) {
  if (publicFiles.has(path)) return true;
  if (path.startsWith('src/scratch/')) return false;
  const isSource = path.startsWith('src/');
  if (path.split('/').some(part => !part || part.startsWith('.') || (!isSource && localName.test(part)))) return false;
  return publicTrees.some(([root, extension]) => path.startsWith(root) && extension.test(path));
}

function git(args, input) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: repository, input, maxBuffer: 64 * 1024 * 1024,
  });
}

function checkDestination(target) {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isDirectory() || readdirSync(target).length !== 0) {
    throw new Error('Choose a new or empty directory for the public export.');
  }
  return true;
}

function exportPublicTree(destination) {
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const records = git(['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean);
  const entries = records.flatMap(record => {
    const tab = record.indexOf('\t');
    const [mode, kind, hash] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (!isPublicPath(path)) return [];
    if (kind !== 'blob' || !['100644', '100755'].includes(mode) ||
        path.split('/').some(part => /[\x00-\x1f<>:"\\|?*]|[. ]$/u.test(part))) {
      throw new Error('Unsupported tracked entry for the public export: ' + path);
    }
    return [{ path, hash, mode }];
  });
  const expected = new Set(entries.map(({ path }) => path));
  const missing = required.filter(path => !expected.has(path));
  for (const root of ['src/', 'fixtures/', 'tests/']) {
    if (!entries.some(({ path }) => path.startsWith(root))) missing.push(root);
  }
  if (missing.length) throw new Error('HEAD is missing release files: ' + missing.join(', '));

  const requested = resolve(destination);
  checkDestination(requested);
  const blobs = git(['cat-file', '--batch'], entries.map(({ hash }) => hash + '\n').join(''));
  mkdirSync(dirname(requested), { recursive: true });
  const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested));
  const stage = mkdtempSync(join(parent, '.importmedic-export-'));
  let renamed = false;
  try {
    let offset = 0;
    for (const { path, hash, mode } of entries) {
      const newline = blobs.indexOf(10, offset);
      const [id, kind, length] = blobs.toString('ascii', offset, newline).split(' ');
      const size = Number(length);
      const end = newline + 1 + size;
      if (newline < offset || id !== hash || kind !== 'blob' || !Number.isSafeInteger(size) || size < 0 || blobs[end] !== 10) {
        throw new Error('Git returned an incomplete blob for ' + path);
      }
      const bytes = blobs.subarray(newline + 1, end);
      const file = join(stage, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
      if (!readFileSync(file).equals(bytes)) throw new Error('Export verification failed for ' + path);
      offset = end + 1;
    }
    const exported = readdirSync(stage, { recursive: true })
      .filter(path => !lstatSync(join(stage, path)).isDirectory())
      .map(path => path.split(sep).join('/'));
    if (offset !== blobs.length || exported.length !== expected.size ||
        exported.some(path => !expected.has(path) || !isPublicPath(path))) {
      throw new Error('The public export did not match the selected HEAD files.');
    }
    if (checkDestination(target)) rmdirSync(target);
    renameSync(stage, target);
    renamed = true;
    console.log('Verified ' + exported.length + ' public files from ' + commit + ' at ' + target);
  } finally {
    if (!renamed) {
      const temporary = realpathSync(stage);
      if (dirname(temporary) === parent && basename(temporary).startsWith('.importmedic-export-')) {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}

try {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length) throw new Error('Usage: npm run export:public -- <targetDir>');
  exportPublicTree(destination);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
