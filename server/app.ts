/**
 * Semovix Voice Studio - Express 应用工厂
 * 供 server.ts（真实服务）与 supertest 集成测试共用；
 * 不监听端口、不挂 Vite，保证可独立实例化。
 */
import express from 'express';
import { voiceModelStatusRouter } from './routes/voiceModelStatus';
import { generateSpeechRouter } from './routes/generateSpeech';
import { soundRecipeRouter } from './routes/soundRecipe';
import { musicPatternRouter } from './routes/musicPattern';
import { guofengRouter } from './routes/guofeng';
import { transcribeRouter } from './routes/transcribe';
import { autoTagRouter } from './routes/autoTag';
import { libraryRouter } from './routes/library';
import { generationsRouter } from './routes/generations';
import { voiceDesignRouter } from './routes/voiceDesign';
import { voiceLifecycleRouter } from './routes/voiceLifecycle';
import { voiceIdentitiesRouter } from './routes/voiceIdentities';
import { voiceCloneRouter } from './routes/voiceClone';
import { voiceAdditionalSourcesRouter } from './routes/voiceAdditionalSources';
import { voiceSourceLifecycleRouter } from './routes/voiceSourceLifecycle';
import { voiceProfilesRouter } from './routes/voiceProfiles';
import { jobsRouter } from './routes/jobs';
import { modelsRouter } from './routes/models';
import { eventsRouter } from './routes/events';
import { storageRouter } from './routes/storage';
import { openaiCompatRouter } from './routes/openaiCompat';
import { mcpRouter } from './routes/mcp';

export function createApp(): express.Express {
  const app = express();

  // P2 #41：MCP 端点必须先于全局 JSON 解析器挂载——transcribe 的 audioBase64
  // （100MB ≈ 133MB base64 文本）超过下方 50mb 全局上限，路由自带更大解析器
  app.use(mcpRouter);

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use('/api', voiceModelStatusRouter);
  app.use('/api', generateSpeechRouter);
  app.use('/api', soundRecipeRouter);
  app.use('/api', musicPatternRouter);
  app.use('/api', guofengRouter);
  app.use('/api', transcribeRouter);
  app.use('/api', autoTagRouter);
  app.use('/api', libraryRouter);
  app.use('/api', generationsRouter);
  app.use('/api', voiceDesignRouter);
  app.use('/api', voiceLifecycleRouter);
  app.use('/api', voiceIdentitiesRouter);
  app.use('/api', voiceCloneRouter);
  app.use('/api', voiceAdditionalSourcesRouter);
  app.use('/api', voiceSourceLifecycleRouter);
  app.use('/api', voiceProfilesRouter);
  app.use('/api', jobsRouter);
  // P1 #32：模型目录 / 下载 / 删除 / 版本切换（内部经统一 Job 体系）
  app.use('/api', modelsRouter);
  // P1 #34：SSE 事件流（长连接；自身不 next 错误，不经过下方错误中间件）
  app.use('/api', eventsRouter);
  // P1 #39：存储治理（保留策略 + 占用统计 + 立即清理）
  app.use('/api', storageRouter);
  // P2 #42：OpenAI 兼容音频端点（/v1/audio/*，路径自带前缀；早于 server.ts 的 SPA 通配符）
  app.use(openaiCompatRouter);

  // P0-B #24：全局错误中间件——路由内 re-throw 的意外异常一律 JSON 下发，
  // 不再落回 Express 默认 HTML 500（破坏错误合同的路径已全部收口到这里）
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return; // 响应已开始下发（如 sendFile 中途失败）：交还默认机制
    const err = error as { message?: string; code?: string; status?: number } | null;
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    console.error('[api] unhandled route error:', error);
    res.status(status).json({
      error: err?.message || '服务器内部错误',
      code: typeof err?.code === 'string' && err.code ? err.code : 'internal_error',
    });
  });

  return app;
}
