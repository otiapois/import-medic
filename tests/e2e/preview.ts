import type { FullConfig } from '@playwright/test';
import { preview } from 'vite';

// Owning the server in the runner lets Windows teardown close its socket
// directly, even where process-tree termination is restricted.
export default async function startPreview(config: FullConfig) {
  const { hostname, port } = new URL(config.projects[0].use.baseURL!);
  const server = await preview({ preview: { host: hostname, port: Number(port), strictPort: true } });
  return () => server.close();
}

