/**
 * Library API (素材库：SQLite 元数据 + 磁盘文件)
 *
 * P01 数据完整性：
 * - 上传 100MB 上限（413 file_too_large）、MIME 校验（415）、服务端 WAV 解析（400 invalid_audio_file）；
 * - 素材 ID 在路由边界校验（400 invalid_id），不再让 assertSafeId 漏成 500；
 * - 音频写入走 writeItemFileAtomic（tmp→fsync→backup→rename→DB tx→回滚恢复）。
 */
import { Router, type Response } from 'express';
import {
  listItems, getItem, saveItem, updateItem, deleteItem,
  writeItemFileAtomic, readItemFile,
  listFolders, saveFolder, deleteFolder, replaceFolders,
  SAFE_ID,
} from '../db/libraryStore';
import { parseWav, type ParsedWav } from '../audio/wav';
import { uploadSingle } from './upload';
import { fail } from './respond';

export const libraryRouter = Router();

/** 路由边界 ID 校验：失败时已写响应并返回 false */
function requireSafeId(res: Response, id: unknown, label = '素材'): boolean {
  if (typeof id === 'string' && SAFE_ID.test(id)) return true;
  fail(res, 400, `非法${label} ID: ${String(id)}（仅字母/数字/_/-，长度 1-128）`, 'invalid_id');
  return false;
}

/** 允许的音频 MIME（部分浏览器对 wav 报 application/octet-stream，放行后按字节判别） */
function isAudioMime(mime: string | undefined): boolean {
  return !!mime && (mime.startsWith('audio/') || mime === 'application/octet-stream');
}

/**
 * 服务端音频校验：MIME 白名单（415）+ WAV 字节级解析（400 invalid_audio_file）。
 * 返回解析出的 wav 元数据（非 wav 格式为 null，元数据以客户端申报兜底）。
 */
function inspectAudio(
  res: Response,
  file: { buffer: Buffer; mimetype?: string },
  format: string
): ParsedWav | null | undefined {
  if (!isAudioMime(file.mimetype)) {
    fail(res, 415, `不支持的媒体类型: ${file.mimetype || '未知'}（仅接受 audio/* 上传）。`, 'unsupported_media_type');
    return undefined; // 已写失败响应
  }
  const isWav = format === 'wav' || file.buffer.subarray(0, 4).toString('ascii') === 'RIFF';
  if (!isWav) return null; // 非 wav：不强行解析，元数据走申报值
  try {
    return parseWav(file.buffer);
  } catch (e) {
    fail(res, 400, `音频文件无效：${(e as Error).message || '不是合法的 RIFF/WAVE 文件'}`, 'invalid_audio_file');
    return undefined;
  }
}

libraryRouter.get('/library/items', (_req, res) => {
  res.json({ items: listItems() });
});

/**
 * 新建/覆盖素材。multipart/form-data：字段 item（JSON 字符串）+ 文件 audio（可选）。
 * 硬性约束 #7：音频一律 multipart，JSON Base64 一律 400。
 */
libraryRouter.post('/library/items', uploadSingle('audio'), (req, res) => {
  try {
    if (req.body?.audioBase64) {
      return fail(res, 400, 'JSON Base64 传输已停用：请以 multipart/form-data 上传音频文件（字段名 audio）。', 'unsupported_transport');
    }
    const rawItem = req.body?.item;
    const item = typeof rawItem === 'string' ? JSON.parse(rawItem) : rawItem;
    if (!item || !item.id) {
      return fail(res, 400, 'item (含 id) is required.', 'invalid_request');
    }
    if (!requireSafeId(res, item.id)) return;

    let payload = { ...item };
    if (req.file && req.file.buffer.length > 0) {
      const format = item.format || 'wav';
      const parsed = inspectAudio(res, req.file, format);
      if (parsed === undefined) return; // 415 / 400 已写
      const written = writeItemFileAtomic(String(item.id), format, req.file.buffer, {
        mimeType: req.file.mimetype,
        audio: parsed
          ? {
              duration: Math.round(parsed.durationSec * 1000) / 1000,
              sampleRate: parsed.format.sampleRate,
              channels: parsed.format.channels,
              bitsPerSample: parsed.format.bitsPerSample,
              dataSize: parsed.dataLength,
            }
          : null,
      });
      // 服务端解析结果覆盖客户端申报值（硬性约束：不信任客户端元数据）
      payload = {
        ...payload,
        fileSize: written.size,
        sha256: written.sha256,
        mimeType: written.mimeType,
        verifiedAt: new Date().toISOString(),
        ...(parsed
          ? {
              duration: Math.round(parsed.durationSec * 1000) / 1000,
              sampleRate: parsed.format.sampleRate,
              channels: parsed.format.channels,
            }
          : {}),
      };
    }

    const saved = saveItem(payload);
    res.json({ item: saved });
  } catch (error: any) {
    console.error('Library save error:', error);
    res.status(500).json({ error: error.message || 'Failed to save item.', code: 'item_save_failed' });
  }
});

/** 部分更新素材元数据 */
libraryRouter.patch('/library/items/:id', (req, res) => {
  if (!requireSafeId(res, req.params.id)) return;
  const updated = updateItem(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Item not found.', code: 'item_not_found' });
  res.json({ item: updated });
});

/**
 * 覆盖素材音频文件（P01 数据完整性：原子写入 + 服务端元数据解析）。
 * multipart/form-data：文件字段 audio。wav 的 duration/sampleRate/channels
 * 一律以服务端解析为准；非 wav 格式可用 query 申报兜底。
 */
libraryRouter.put('/library/items/:id/audio', uploadSingle('audio'), (req, res) => {
  try {
    if (!requireSafeId(res, req.params.id)) return;
    const existing = getItem(req.params.id);
    if (!existing) return fail(res, 404, 'Item not found.', 'not_found');
    if (!req.file || req.file.buffer.length === 0) {
      return fail(res, 400, 'Audio file is required (multipart/form-data, field "audio").', 'invalid_request');
    }
    const format = existing.format || 'wav';
    const parsed = inspectAudio(res, req.file, format);
    if (parsed === undefined) return; // 415 / 400 已写

    const written = writeItemFileAtomic(req.params.id, format, req.file.buffer, {
      mimeType: req.file.mimetype,
      audio: parsed
        ? {
            duration: Math.round(parsed.durationSec * 1000) / 1000,
            sampleRate: parsed.format.sampleRate,
            channels: parsed.format.channels,
            bitsPerSample: parsed.format.bitsPerSample,
            dataSize: parsed.dataLength,
          }
        : null,
    });

    const metaUpdates: Record<string, unknown> = {
      fileSize: written.size,
      sha256: written.sha256,
      mimeType: written.mimeType,
      verifiedAt: new Date().toISOString(),
    };
    if (parsed) {
      // 服务端解析为准（不再信任 query 申报值）
      metaUpdates.duration = Math.round(parsed.durationSec * 1000) / 1000;
      metaUpdates.sampleRate = parsed.format.sampleRate;
      metaUpdates.channels = parsed.format.channels;
    } else {
      // 非 wav：query 申报兜底
      const duration = Number(req.query.duration);
      const sampleRate = Number(req.query.sampleRate);
      const channels = Number(req.query.channels);
      if (Number.isFinite(duration) && duration > 0) metaUpdates.duration = duration;
      if (Number.isFinite(sampleRate) && sampleRate > 0) metaUpdates.sampleRate = sampleRate;
      if (Number.isFinite(channels) && channels > 0) metaUpdates.channels = channels;
    }
    const updated = updateItem(req.params.id, metaUpdates);
    res.json({ item: updated, fileSize: written.size });
  } catch (error: any) {
    console.error('Library audio overwrite error:', error);
    res.status(500).json({ error: error.message || 'Failed to overwrite audio file.', code: 'item_overwrite_failed' });
  }
});

/** 删除单个素材（含磁盘文件） */
libraryRouter.delete('/library/items/:id', (req, res) => {
  if (!requireSafeId(res, req.params.id)) return;
  const ok = deleteItem(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Item not found.', code: 'item_not_found' });
  res.json({ items: listItems() });
});

/** 批量删除 */
libraryRouter.post('/library/items/batch-delete', (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  for (const id of ids) {
    if (!requireSafeId(res, id)) return;
  }
  for (const id of ids) deleteItem(id);
  res.json({ items: listItems() });
});

/** 批量移动到文件夹（folderId 为 null/undefined = 未分类） */
libraryRouter.post('/library/move', (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  for (const id of ids) {
    if (!requireSafeId(res, id)) return;
  }
  const folderId = req.body?.folderId ?? null;
  for (const id of ids) updateItem(id, { folderId });
  res.json({ items: listItems() });
});

/** 批量追加标签 */
libraryRouter.post('/library/tags', (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  for (const id of ids) {
    if (!requireSafeId(res, id)) return;
  }
  const newTags: string[] = Array.isArray(req.body?.tags) ? req.body.tags : [];
  for (const id of ids) {
    const current = getItem(id);
    if (!current) continue;
    const merged = Array.from(new Set([...(current.tags || []), ...newTags]));
    updateItem(id, { tags: merged });
  }
  res.json({ items: listItems() });
});

/** 素材音频文件（res.sendFile 自带 Range 分段播放支持） */
libraryRouter.get('/library/file/:id', (req, res) => {
  if (!requireSafeId(res, req.params.id)) return;
  const file = readItemFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'Audio file not found.', code: 'audio_not_found' });
  const mime = file.fileName.endsWith('.wav') ? 'audio/wav'
    : file.fileName.endsWith('.mp3') ? 'audio/mpeg'
    : file.fileName.endsWith('.webm') ? 'audio/webm'
    : file.fileName.endsWith('.ogg') ? 'audio/ogg'
    : 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.sendFile(file.filePath);
});

/** 列出文件夹（空库自动播种默认文件夹） */
libraryRouter.get('/library/folders', (_req, res) => {
  res.json({ folders: listFolders() });
});

/** 新建/更新文件夹 */
libraryRouter.post('/library/folders', (req, res) => {
  try {
    const { id, name, color, createdAt } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id and name are required.', code: 'invalid_request' });
    if (!requireSafeId(res, id, '文件夹')) return;
    const folder = saveFolder({ id, name, color, createdAt });
    res.json({ folder, folders: listFolders() });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to save folder.', code: 'folder_save_failed' });
  }
});

/** 整表替换文件夹（迁移用） */
libraryRouter.post('/library/folders/replace', (req, res) => {
  try {
    const folders = Array.isArray(req.body?.folders) ? req.body.folders : [];
    for (const f of folders) {
      if (!f?.id || !SAFE_ID.test(String(f.id))) {
        return fail(res, 400, `非法文件夹 ID: ${String(f?.id)}`, 'invalid_id');
      }
    }
    res.json({ folders: replaceFolders(folders) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to replace folders.', code: 'folder_replace_failed' });
  }
});

/** 删除文件夹（素材保留并归入未分类） */
libraryRouter.delete('/library/folders/:id', (req, res) => {
  if (!requireSafeId(res, req.params.id, '文件夹')) return;
  deleteFolder(req.params.id);
  res.json({ folders: listFolders() });
});
