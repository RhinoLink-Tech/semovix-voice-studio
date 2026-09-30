/**
 * 生成记录与输出工件（可追溯性）
 * - GET /api/generations?itemId=&limit=  生成留痕（含失败记录）
 * - GET /api/artifacts/:id               生成输出 WAV（sendFile 支持 Range）
 * - GET /api/artifacts/:id?format=mp3|opus  压缩衍生输出（P2 #48，内存转码不落盘）
 */
import fs from 'fs';
import { Router } from 'express';
import { listGenerations, readArtifactFile } from '../db/generationsStore';
import { PipelineHttpError } from '../lib/speechPipeline';
import { transcodeWav, transcodeContentType, type TranscodeFormat } from '../lib/audioTranscode';
import { fail } from './respond';

export const generationsRouter = Router();

generationsRouter.get('/generations', (req, res) => {
  const itemId = typeof req.query.itemId === 'string' && req.query.itemId ? req.query.itemId : undefined;
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) || 50 : 50;
  res.json({ generations: listGenerations({ itemId, limit }) });
});

generationsRouter.get('/artifacts/:id', async (req, res) => {
  const file = readArtifactFile(req.params.id);
  if (!file) return fail(res, 404, 'Artifact not found.', 'not_found');

  const requested = typeof req.query.format === 'string' ? req.query.format : 'wav';
  if (requested !== 'wav' && requested !== 'mp3' && requested !== 'opus') {
    return fail(res, 400, `Unsupported format: ${requested} (supported: wav, mp3, opus).`, 'unsupported_format');
  }
  if (requested === 'wav') {
    // 权威产物：默认路径逐字节不变（sendFile + Range）
    res.setHeader('Content-Type', 'audio/wav');
    return res.sendFile(file.filePath);
  }

  // 压缩衍生：读 WAV → 内存转码 → 直接下发（不落盘；失败如实透传）
  try {
    const wav = fs.readFileSync(file.filePath);
    const audio = await transcodeWav(wav, requested as TranscodeFormat);
    res.setHeader('Content-Type', transcodeContentType(requested as TranscodeFormat));
    res.send(audio);
  } catch (error) {
    if (error instanceof PipelineHttpError) {
      return fail(res, error.status, error.message, error.code, error.extra);
    }
    console.error('[artifacts] transcode error:', error);
    return fail(res, 500, 'Failed to transcode artifact.', 'transcode_failed');
  }
});
