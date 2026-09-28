/**
 * Semovix Voice Studio - 服务端入口
 * dotenv 必须先于任何 config 取值执行；业务逻辑在 server/ 目录模块化。
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createApp } from './server/app';
import { getConfig } from './server/config';
import { resumeProviderPreviewJobs } from './server/routes/voiceAdditionalSources';
import { resumeSourceValidationJobs } from './server/routes/voiceSourceLifecycle';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = createApp();
  const { port, isProduction } = getConfig();

  // 桌面壳健康检查身份标识：端口被本机其他服务（如 Grafana，302→登录页 200）
  // 接管时，Electron 靠此字段甄别"应答的确实是本服务"
  app.get('/api/ping', (_req, res) => {
    res.json({ service: 'semovix-voice-studio' });
  });
  // 试听任务的状态已经持久化；启动时恢复因重启中断的 Provider 任务。
  void resumeProviderPreviewJobs().catch(error => console.error('无法恢复 Provider 试听任务:', error));
  void resumeSourceValidationJobs().catch(error => console.error('无法恢复来源验证任务:', error));

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // 生产包输出为 dist/server.mjs；静态文件与入口在同一目录。
    // 开发入口仍位于项目根，因此不能沿用固定的 root/dist 推导。
    const distPath = __dirname;
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  // P01 安全默认：仅本机监听，不暴露到局域网
  app.listen(port, '127.0.0.1', () => {
    console.log(`Semovix Voice Studio running at http://127.0.0.1:${port}`);
  });
}

startServer();
