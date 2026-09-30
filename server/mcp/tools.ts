/**
 * MCP 工具定义（P2 #41）：list_voice_profiles / generate_speech / transcribe /
 * check_runtime / get_generation。
 *
 * 硬性约束（docs/001.md #41）：
 * - 只能使用已发布 Voice Profile（冻结目录 + manifest SHA-256 校验），
 *   候选/草稿物理不可达；generate_speech 非 profile: 形态一律拒绝。
 * - 工具结果只返回文件路径/URL/元数据，绝不把 WAV Base64 放进 Agent 上下文。
 * - 每次调用写使用记录——由共享管线（speechPipeline/transcribePipeline）
 *   的 generations 台账承担，params.source='mcp' 可区分来源。
 */
import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runSpeech, PipelineHttpError } from '../lib/speechPipeline';
import { runTranscription } from '../lib/transcribePipeline';
import { listPublishedVoiceProfiles } from '../lib/profileManifest';
import { resolveAgentDefaultVoice } from '../lib/agentVoice';
import { getWorkerStatus, type WorkerEngineSnapshot } from '../engines/qwenWorker';
import { availableBytes } from '../lib/diskUsage';
import { getConfig } from '../config';
import { getGenerationById, readArtifactFile } from '../db/generationsStore';
import { MAX_UPLOAD_MB } from '../routes/upload';

/** 请求上下文：拼绝对 URL 用（Agent 进程可能不知道端口，相对路径不可点） */
export interface McpRequestContext {
  baseUrl: string;
}

const MCP_SERVER_VERSION = '2026.9.25';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** 工具结果统一 JSON 文本（结构化、可读、无音频字节） */
function toolJson(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toolError(message: string, code?: string): ToolResult {
  return {
    content: [{ type: 'text', text: code ? `${message}（code: ${code}）` : message }],
    isError: true,
  };
}

function pipelineError(error: unknown): ToolResult {
  if (error instanceof PipelineHttpError) return toolError(error.message, error.code);
  console.error('[mcp] tool error:', error);
  return toolError(error instanceof Error ? error.message : String(error));
}

/** transcribe 的本地文件入口守卫：类型白名单 + 大小上限 + 常规文件（收窄任意文件读取面） */
const TRANSCRIBE_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.oga', '.opus', '.webm', '.flac']);

function readAudioFileForTranscribe(audioFilePath: string): Buffer {
  if (!path.isAbsolute(audioFilePath)) {
    throw new Error('audioFilePath 必须是本机绝对路径（或改用 audioBase64）。');
  }
  if (!TRANSCRIBE_AUDIO_EXTENSIONS.has(path.extname(audioFilePath).toLowerCase())) {
    throw new Error(`不支持的音频扩展名: ${path.extname(audioFilePath) || '（无）'}（支持: ${[...TRANSCRIBE_AUDIO_EXTENSIONS].join(' ')}）。`);
  }
  const stats = fs.statSync(audioFilePath); // 不存在/不可达 → 抛错，如实上报
  if (!stats.isFile()) throw new Error('audioFilePath 不是常规文件。');
  if (stats.size > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`音频文件超过大小上限（${MAX_UPLOAD_MB}MB）。`);
  }
  return fs.readFileSync(audioFilePath);
}

function engineSnapshot(id: string, snapshot: WorkerEngineSnapshot) {
  return {
    id,
    state: snapshot.state,
    available: snapshot.available,
    error: snapshot.error,
    ...(snapshot.checkpoint !== undefined ? { checkpoint: snapshot.checkpoint } : {}),
  };
}

export function createMcpServer(context: McpRequestContext): McpServer {
  const server = new McpServer({ name: 'semovix-voice-studio', version: MCP_SERVER_VERSION });

  server.registerTool(
    'list_voice_profiles',
    {
      title: '已发布 Voice Profile 目录',
      description:
        '列出库中全部已发布（冻结且 manifest SHA-256 校验通过）的 Voice Profile。返回的 voiceName 是 generate_speech 的 voice 参数精确值（profile:<identityId>@<version>）。候选/草稿不在其列；校验失败的损坏版本不进入列表但会如实计数。',
    },
    async () => {
      const { profiles, skipped } = await listPublishedVoiceProfiles();
      return toolJson({
        profiles: profiles.map(profile => ({
          voiceName: profile.voiceName,
          identityId: profile.identityId,
          identityName: profile.identityName,
          profileName: profile.profileName,
          version: profile.version,
          language: profile.language,
          productionModel: profile.productionModel,
          frozenAt: profile.frozenAt,
          referenceText: profile.referenceText,
          manifestUrl: `${context.baseUrl}${profile.manifestUrl}`,
          referenceAudioUrl: `${context.baseUrl}${profile.referenceAudioUrl}`,
        })),
        ...(skipped > 0 ? { skippedCorrupt: skipped } : {}),
      });
    }
  );

  server.registerTool(
    'generate_speech',
    {
      title: '语音合成（已发布 Voice Profile）',
      description:
        '用已发布 Voice Profile 合成语音，产物为 24kHz 16-bit PCM WAV（format=mp3/opus 时 audioUrl 指向按需转码的压缩衍生，需本机装有 ffmpeg）。voice 省略时按 agent 绑定 → 全局默认 → 唯一已发布 Profile 解析（#47）。结果只含音频 URL 与本地文件路径，不含音频字节；每次调用写入 generations 使用记录。',
      inputSchema: {
        text: z.string().describe('要合成的文本'),
        voice: z
          .string()
          .optional()
          .describe('已发布 Voice Profile 的 voiceName（profile:<identityId>@<version>，见 list_voice_profiles）；省略则按绑定解析默认声音'),
        agent: z.string().optional().describe('调用方 Agent 标识（用于默认声音绑定，如 xino、video-agent）'),
        speed: z.number().optional().describe('语速（默认 1.0）'),
        emotion: z.string().optional().describe('情绪/语气提示'),
        format: z.enum(['wav', 'mp3', 'opus']).optional().describe('衍生音频格式（默认 wav；mp3/opus 需本机装有 ffmpeg，audioUrl 以 ?format= 指向压缩版）'),
      },
    },
    async ({ text, voice, agent, speed, emotion, format = 'wav' }) => {
      let voiceName = voice;
      let voiceResolvedFrom: string | undefined;
      if (!voiceName) {
        try {
          const resolution = await resolveAgentDefaultVoice(agent);
          voiceName = resolution.voiceName;
          voiceResolvedFrom = resolution.resolvedFrom;
        } catch (error) {
          return toolError(error instanceof Error ? error.message : String(error));
        }
      } else if (!voiceName.startsWith('profile:')) {
        // 文档约束从严执行：Agent 只能用受治理的已发布 Profile，不接受内置/自由音色
        return toolError('仅支持已发布 Voice Profile（voice 形如 profile:<identityId>@<version>）；请先用 list_voice_profiles 查询可用声音。', 'invalid_voice_profile');
      }

      try {
        const result = await runSpeech({
          text,
          voiceName,
          ttsModel: 'voice-profile',
          ...(speed !== undefined ? { speed } : {}),
          ...(emotion ? { emotion } : {}),
          source: 'mcp',
        });
        const artifact = readArtifactFile(result.generationId);
        return toolJson({
          generationId: result.generationId,
          // 压缩衍生（#48）：URL 带 ?format=，由 GET /api/artifacts/:id 按需转码
          audioUrl: `${context.baseUrl}${result.artifactUrl}${format === 'wav' ? '' : `?format=${format}`}`,
          filePath: artifact?.filePath ?? null,
          format,
          durationSeconds: result.duration,
          sampleRate: result.sampleRate,
          engine: result.engine,
          ...(result.provenance ? { provenance: result.provenance } : {}),
          ...(voiceResolvedFrom ? { voiceResolvedFrom } : {}),
        });
      } catch (error) {
        return pipelineError(error);
      }
    }
  );

  server.registerTool(
    'transcribe',
    {
      title: '音频转录',
      description:
        '转录一段音频为文本。audioFilePath（本机绝对路径）与 audioBase64 二选一；model 省略时自动路由（优先本地 Whisper，其次 Gemini）。每次调用写入 generations 使用记录。',
      inputSchema: {
        audioFilePath: z.string().optional().describe('本机音频文件绝对路径（扩展名 wav/mp3/m4a/ogg/oga/opus/webm/flac）'),
        audioBase64: z.string().optional().describe('音频内容 base64（与 audioFilePath 二选一）'),
        model: z.string().optional().describe('转录模型 ID（whisper-local / gemini-2.5-flash 等；OpenAI 的 whisper-1 视为 whisper-local）'),
        language: z.enum(['auto', 'zh', 'en']).optional().describe('提示语言（默认 auto）'),
      },
    },
    async ({ audioFilePath, audioBase64, model, language }) => {
      const hasPath = typeof audioFilePath === 'string' && audioFilePath.length > 0;
      const hasBase64 = typeof audioBase64 === 'string' && audioBase64.length > 0;
      if (hasPath === hasBase64) {
        return toolError('audioFilePath 与 audioBase64 必须二选一（且只提供一个）。');
      }
      try {
        let audio: Buffer;
        if (hasPath) {
          audio = readAudioFileForTranscribe(audioFilePath!);
        } else {
          audio = Buffer.from(audioBase64!, 'base64');
          if (audio.length === 0) return toolError('audioBase64 解码后为空。');
          if (audio.length > MAX_UPLOAD_MB * 1024 * 1024) return toolError(`音频超过大小上限（${MAX_UPLOAD_MB}MB）。`);
        }
        const resolvedModel = model === 'whisper-1' ? 'whisper-local' : model;
        const result = await runTranscription(audio, {
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(language ? { language } : {}),
          includeInsights: false, // Agent 只要文字稿；摘要/情绪/标签是产品内增强
          source: 'mcp',
        });
        return toolJson({
          transcript: result.transcript,
          engine: result.engine,
          generationId: result.generationId,
          ...(result.engine === 'whisper-local' ? { durationSeconds: result.duration, detectedLanguage: result.language } : {}),
        });
      } catch (error) {
        return pipelineError(error);
      }
    }
  );

  server.registerTool(
    'check_runtime',
    {
      title: '运行时状态',
      description: '查询本地语音运行时：Worker 进程可达性/协议版本、四个引擎的加载状态（cold/loading/ready/error）、素材库所在卷的可用磁盘空间。合成/转录前可用它判断引擎是否就绪。',
    },
    async () => {
      const [worker, diskAvailableBytes] = await Promise.all([
        getWorkerStatus(),
        availableBytes(getConfig().libraryDir),
      ]);
      return toolJson({
        worker: {
          reachable: worker.reachable,
          ...(worker.protocolVersion !== undefined ? { protocolVersion: worker.protocolVersion } : {}),
        },
        engines: [
          engineSnapshot('qwen_tts', worker.qwen_tts),
          engineSnapshot('voice_design', worker.voice_design),
          engineSnapshot('voice_clone', worker.voice_clone),
          engineSnapshot('whisper_asr', worker.whisper_asr),
        ],
        ...(diskAvailableBytes !== null ? { diskAvailableBytes } : { diskAvailableBytes: null }),
      });
    }
  );

  server.registerTool(
    'get_generation',
    {
      title: '查询生成记录',
      description:
        '按 generationId 查询一次合成/转录的使用记录（引擎、模型、溯源、输入/输出哈希、状态），并附音频 URL 与本地文件路径（无输出时如实为 null）。',
      inputSchema: {
        generationId: z.string().describe('生成记录 ID（generate_speech/transcribe 返回的 generationId）'),
      },
    },
    async ({ generationId }) => {
      const record = getGenerationById(generationId);
      if (!record) {
        return toolError(`未找到生成记录 ${generationId}。`, 'not_found');
      }
      const artifact = record.kind === 'tts' && record.status === 'done' ? readArtifactFile(record.id) : null;
      return toolJson({
        generation: record,
        audioUrl: artifact ? `${context.baseUrl}/api/artifacts/${record.id}` : null,
        filePath: artifact?.filePath ?? null,
      });
    }
  );

  return server;
}
