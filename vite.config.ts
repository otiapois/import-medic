import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '.vite/cache',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'preview-prerendered-routes',
      configurePreviewServer(server) {
        const dist = resolve(server.config.root, server.config.build.outDir);
        // Serve the same wildcard response headers as the Cloudflare Pages artifact.
        const [pattern, ...rules] = readFileSync(resolve(dist, '_headers'), 'utf8').trimEnd().split(/\r?\n/);
        if (pattern !== '/*' || rules.length === 0) throw new Error('Expected a single /* rule in dist/_headers');
        const headers = rules.map((rule) => {
          const match = /^[ \t]+([\w-]+): (.+)$/.exec(rule);
          if (!match) throw new Error(`Invalid header in dist/_headers: ${rule}`);
          return [match[1], match[2]] as const;
        });
        server.middlewares.use((request, response, next) => {
          for (const [name, value] of headers) response.setHeader(name, value);
          const url = request.url ?? '';
          const [pathname] = url.split('?', 1);
          // Vite's directory-index lookup requires a trailing slash.
          if (/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(pathname) &&
              existsSync(resolve(dist, `.${pathname}`, 'index.html'))) {
            request.url = `${pathname}/${url.slice(pathname.length)}`;
          }
          next();
        });
      },
    },
  ],
});
