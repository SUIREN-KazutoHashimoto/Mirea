import { createApp } from './app.js';
import { loadEnvironment, runtimeConfig,loadTlsOptions } from './runtime.js';

loadEnvironment();
const { host, port, dataDir } = runtimeConfig();
const https=await loadTlsOptions();
const app = await createApp({ logger: true, dataDir,https });
const shutdown = async () => { await app.close(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
