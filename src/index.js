'use strict';
const { createApp } = require('./server');

async function main() {
  const app = createApp();
  const s = app.config.settings;
  try {
    await app.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${s.port} 已被占用：智能路由可能已经在运行了。打开 http://${s.host}:${s.port} 查看。`);
      process.exit(1);
    }
    throw e;
  }
  const base = `http://${s.host}:${s.port}`;
  const order = app.config.providers.map((p) => `${p.name}${app.state.isConfigured(p) ? '' : '(未配置)'}`).join(' > ');
  app.bus.log('info', 'start', `智能路由已启动，优先级：${order}`);
  console.log(`\n  控制面板:  ${base}\n  CC Switch 中转地址: ${base}\n  路由密钥(API Key):  ${s.routerKey}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('正在退出…');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
}

main();
