import { buildServer } from './server';
import { closeStore } from './lib/store';

async function main() {
  const app = await buildServer();

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }

  async function shutdown() {
    app.log.info('正在关闭...');
    await app.close();
    await closeStore();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
