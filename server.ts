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
import { getDb } from './server/db/libraryStore';
import { recoverJobsOnBoot, shutdownActiveJobs } from './server/jobs/runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = createApp();
  const { port, isProduction } = getConfig();

  // P0-B #30：启动即打开素材库跑迁移——失败（已恢复批次前备份）时如实退出进程，
  // 不让服务带着不确定 schema 继续应答
  try {
    getDb();
  } catch (error) {
    console.error('素材库迁移失败（库已回滚到迁移前备份）：', error);
    process.exit(1);
  }

  // 桌面壳健康检查身份标识：端口被本机其他服务（如 Grafana，302→登录页 200）
  // 接管时，Electron 靠此字段甄别"应答的确实是本服务"
  app.get('/api/ping', (_req, res) => {
    res.json({ service: 'semovix-voice-studio' });
  });
  // 统一 Job 基座：启动恢复（doc #17）——清理过期幂等键、补登记领域孤儿、按领域事实重分类。
  void recoverJobsOnBoot().catch(error => console.error('无法恢复统一任务:', error));

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

  // 受控停机（doc #15/#16）：以 app_shutdown 取消活跃任务，宽限 10s 等领域终态落盘
  const shutdown = async (signal: string) => {
    console.log(`收到 ${signal}，正在停止统一任务…`);
    try { await shutdownActiveJobs(10_000); }
    catch (error) { console.error('停止统一任务失败:', error); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

startServer();
