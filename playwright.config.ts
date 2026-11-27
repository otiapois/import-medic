import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const scratch = resolve('.vite/playwright');
const temp = resolve(scratch, 'temp');
mkdirSync(temp, { recursive: true });
for (const name of ['TMP', 'TEMP', 'TMPDIR']) process.env[name] = temp;
if (process.platform === 'win32') process.env.PLAYWRIGHT_BROWSERS_PATH = 'D:/cache/ms-playwright';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: resolve(scratch, 'results'),
  globalSetup: './tests/e2e/preview.ts',
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:43871',
    channel: 'msedge',
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    acceptDownloads: true,
    launchOptions: { downloadsPath: resolve(scratch, 'downloads') },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});

