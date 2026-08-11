import path from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import cron from 'node-cron';
import apiRoutes from './routes/api';
import uiRoutes from './routes/ui';
import { reconcile } from './jobs/reconcile';
import { envInt } from './config';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      ...(process.env.NODE_ENV !== 'production'
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    },
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });

  app.register(apiRoutes);
  app.register(uiRoutes);

  const staticDir = process.env.STATIC_DIR || 'web/dist';
  const absStatic = path.resolve(staticDir);
  try {
    await app.register(fstatic, {
      root: absStatic,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
    });

    app.setNotFoundHandler((_request, reply) => {
      return reply.sendFile('index.html', absStatic);
    });
  } catch {
    app.log.warn({ dir: absStatic }, '静态文件目录不存在，跳过前端托管');
  }

  const reconcileMinutes = envInt('RECONCILE_INTERVAL_MINUTES', 10);
  cron.schedule(`*/${reconcileMinutes} * * * *`, () => {
    reconcile(app.log).catch((e) => {
      app.log.error({ err: String(e) }, '对账任务异常');
    });
  });

  return app;
}
