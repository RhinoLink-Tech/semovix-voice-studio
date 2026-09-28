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
import { jobsRouter } from './routes/jobs';

export function createApp(): express.Express {
  const app = express();

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
  app.use('/api', jobsRouter);

  return app;
}
