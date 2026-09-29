/**
 * MCP 服务端（P2 #41）：Streamable HTTP 传输 + 有会话模式（SDK 主线范式）。
 *
 * - POST /mcp：带有效 Mcp-Session-Id → 交既有 transport；无会话且是 initialize 请求
 *   → 新建 {transport, server} 并注册进 Map；其余 → 400（JSON-RPC 错误体，形状同 SDK）。
 *   无效会话 → 404（会话语义细节以本版本 SDK 安装源码为准核对过）。
 * - GET /mcp：服务端主动通知的 SSE 流（客户端带 Accept: text/event-stream）。
 * - DELETE /mcp：会话终止，onclose 时从 Map 清除。
 * - GET/PUT /api/mcp/voice-bindings：#47 按 Agent 绑定默认声音的管理面
 *   （文档定位是 Agent 集成能力而非桌面首版基础能力——curl/脚本即可，不做 UI）。
 *
 * 注意：本路由必须在 app.ts 里挂到全局 express.json() **之前**——
 * MCP transcribe 的 audioBase64（100MB 音频 ≈ 133MB base64 文本）超过全局
 * 50mb JSON 上限，因此本路由自带更大的解析器，其余路由的上限不变。
 */
import { randomUUID } from 'crypto';
import { Router } from 'express';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/tools';
import {
  AGENT_KEY_PATTERN,
  readAgentVoiceBindings,
  writeAgentVoiceBindings,
  assertPublishedVoice,
} from '../lib/agentVoice';
import { MAX_UPLOAD_MB } from './upload';
import { fail } from './respond';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** 进程内会话表（生产单进程；supertest 各 App 共享不影响——工具运行时全部动态取配置） */
const sessions = new Map<string, McpSession>();

/** 测试清理用：关闭并清空全部 MCP 会话 */
export async function closeMcpSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map(({ server }) => server.close()));
  sessions.clear();
}

function jsonRpcError(res: express.Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

function baseUrlOf(req: express.Request): string {
  const host = req.get('host') ?? '127.0.0.1';
  return `http://${host}`;
}

async function startNewSession(req: express.Request, res: express.Response): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: sessionId => {
      sessions.set(sessionId, { transport, server });
    },
    // 规范允许两种 POST 应答（SSE 流 / JSON）；客户端本就必须同时接受两者，
    // JSON 模式对 curl 调试和 supertest 断言都更直接
    enableJsonResponse: true,
  });
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) sessions.delete(sessionId);
  };
  const server = createMcpServer({ baseUrl: baseUrlOf(req) });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function mcpEndpoint(req: express.Request, res: express.Response): void {
  void (async () => {
    const sessionId = req.get('Mcp-Session-Id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        // 与 SDK 有会话语义一致：未知会话 404
        jsonRpcError(res, 404, 'Not Found: Invalid session ID');
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (isInitializeRequest(req.body)) {
      await startNewSession(req, res);
      return;
    }
    jsonRpcError(res, 400, 'Bad Request: Mcp-Session-Id header is required');
  })().catch(error => {
    console.error('[mcp] transport error:', error);
    if (!res.headersSent) jsonRpcError(res, 500, 'Internal Server Error');
  });
}

export const mcpRouter: Router = (() => {
  const router = Router();
  // audioBase64 上限换算：100MB 二进制 → ~133MB base64 文本（留少量 JSON 包装余量）
  router.use(express.json({ limit: Math.ceil(MAX_UPLOAD_MB * 1.4 * 1024 * 1024) }));

  router.post('/mcp', mcpEndpoint);
  router.get('/mcp', mcpEndpoint);
  router.delete('/mcp', mcpEndpoint);

  router.get('/api/mcp/voice-bindings', (_req, res) => {
    res.json(readAgentVoiceBindings());
  });

  router.put('/api/mcp/voice-bindings', (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as {
        agentVoices?: Record<string, unknown>;
        defaultVoice?: unknown;
      };
      const invalidShape =
        (body.agentVoices !== undefined && (typeof body.agentVoices !== 'object' || body.agentVoices === null || Array.isArray(body.agentVoices))) ||
        (body.defaultVoice !== undefined && body.defaultVoice !== null && typeof body.defaultVoice !== 'string');
      if (invalidShape) {
        fail(res, 400, '请求体应为 { agentVoices?: { [agent]: voiceName }, defaultVoice?: string | null }。', 'invalid_bindings');
        return;
      }

      const current = readAgentVoiceBindings();
      const agentVoices: Record<string, string> =
        body.agentVoices !== undefined ? {} : { ...current.agentVoices }; // 提供 agentVoices = 整体替换
      if (body.agentVoices !== undefined) {
        for (const [agent, voice] of Object.entries(body.agentVoices)) {
          if (!AGENT_KEY_PATTERN.test(agent) || typeof voice !== 'string' || !voice) {
            fail(res, 400, `agentVoices 条目非法：${agent}（key 须为 1-120 个非空白字符，value 须为非空 voiceName）。`, 'invalid_bindings');
            return;
          }
          agentVoices[agent] = voice;
        }
      }
      const defaultVoice =
        body.defaultVoice === undefined ? current.defaultVoice : body.defaultVoice === null ? null : String(body.defaultVoice);

      // 落库前整体校验：所有绑定值必须是当前已发布 Profile（候选/草稿不可绑定）
      const voicesToCheck = [...new Set([...Object.values(agentVoices), ...(defaultVoice ? [defaultVoice] : [])])];
      for (const voiceName of voicesToCheck) {
        try {
          await assertPublishedVoice(voiceName);
        } catch (error) {
          fail(res, 400, error instanceof Error ? error.message : String(error), 'invalid_binding_voice');
          return;
        }
      }

      writeAgentVoiceBindings({ agentVoices, defaultVoice });
      res.json({ agentVoices, defaultVoice });
    })().catch(error => {
      console.error('[mcp] voice-bindings error:', error);
      fail(res, 500, '更新声音绑定失败。', 'internal_error');
    });
  });

  return router;
})();
