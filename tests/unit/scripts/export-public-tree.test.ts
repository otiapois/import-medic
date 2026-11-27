import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { expect, it } from 'vitest';

it('exports only public HEAD blobs and leaves an existing export intact', () => {
  const cache = process.platform === 'win32' ? 'D:\\cache\\import-medic\\tmp' : tmpdir();
  mkdirSync(cache, { recursive: true });
  const parent = realpathSync(cache);
  const scratch = mkdtempSync(join(parent, 'export-tree-'));
  try {
    const repo = join(scratch, 'source');
    mkdirSync(repo);
    const publicPaths = [
      '.github/workflows/ci.yml', '.gitignore', 'CHANGELOG.md', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
      'docs/error-catalog.json', 'docs/subsystems/README.md', 'index.html', 'package.json', 'package-lock.json',
      'playwright.config.ts', 'public/_headers', 'scripts/prerender.mjs', 'scripts/repair-cli.ts',
      'src/index.ts', 'tests/unit/example.test.ts', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
    ];
    const expected = new Map<string, Buffer>(publicPaths.map(path => [path, Buffer.from(path + '\n')]));
    expected.set('.gitignore', Buffer.from('.cache/\n'));
    expected.set('scripts/export-public-tree.mjs', readFileSync(new URL('../../../scripts/export-public-tree.mjs', import.meta.url)));
    expected.set('fixtures/sample.xlsx', Buffer.from([0, 255, 13, 10]));
    expected.set('src/core/shopify-price-diff/local-settings.ts', Buffer.from('export const localSettings = true;\n'));
    for (const file of ['recipe.ts', 'workspace-profile.ts', 'settings-validation.ts']) {
      const path = 'src/core/shopify-price-diff/' + file;
      expected.set(path, readFileSync(new URL('../../../' + path, import.meta.url)));
    }
    for (const [path, bytes] of expected) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), bytes);
    }
    for (const path of ['docs/research/M1.5/excluded.md', 'docs/tasks/internal.md', 'docs/reports/log.md',
      'AGENTS.md', 'src/scratch/notes.ts', 'fixtures/operator-local.csv', 'tests/.env']) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), 'synthetic exclusion sentinel');
    }
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'user.name=Export Test', '-c', 'user.email=export-test@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + join(scratch, 'no-hooks'), ...args,
    ], { cwd: repo });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'Create export fixture');
    writeFileSync(join(repo, 'src/index.ts'), 'staged edit');
    git('add', 'src/index.ts');
    writeFileSync(join(repo, 'src/untracked.ts'), 'untracked edit');

    const target = join(scratch, 'public snapshot');
    mkdirSync(target);
    const args = [join(repo, 'scripts/export-public-tree.mjs'), target];
    const output = execFileSync(process.execPath, args, { encoding: 'utf8', cwd: scratch });
    expect(output).toContain('Verified ' + expected.size + ' public files');
    const actual = readdirSync(target, { recursive: true, encoding: 'utf8' })
      .filter(path => statSync(join(target, path)).isFile()).map(path => path.split(sep).join('/')).sort();
    expect(actual).toEqual([...expected.keys()].sort());
    for (const [path, bytes] of expected) expect(readFileSync(join(target, path)).equals(bytes)).toBe(true);
    const repeat = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: scratch });
    expect(repeat.status).toBe(1);
    expect(repeat.stderr).toContain('Choose a new or empty directory');
    expect(readFileSync(join(target, 'src/index.ts')).equals(expected.get('src/index.ts')!)).toBe(true);
  } finally {
    const temporary = realpathSync(scratch);
    if (dirname(temporary) !== parent || temporary !== scratch) throw new Error('Unexpected export test directory');
    rmSync(temporary, { recursive: true, force: true });
  }
}, 15_000);
