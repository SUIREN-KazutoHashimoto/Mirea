import { createApp } from './app.js';
import { loadEnvironment, runtimeConfig,loadTlsOptions } from './runtime.js';

loadEnvironment();
const { host, port, dataDir,mediaDir } = runtimeConfig();
const https=await loadTlsOptions();
const app = await createApp({ bootstrapAdmin:true, remoteUpdates:process.env.APP_UPDATES_SOURCE!=='disabled', logger: true, dataDir,mediaDir,https });
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
