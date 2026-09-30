# 架构说明（Architecture）

> 面向贡献者与审查者的结构速览。能力真实性以 [CAPABILITY_STATUS.md](CAPABILITY_STATUS.md) 为准；本文件描述"是什么"，不构成能力承诺。

## 总体形态：本地优先的四层结构

```
┌────────────────────────────────────────────────┐
│  Web 前端（React + Vite, src/）                 │
│  工作台 / 评审 / 模型目录 / 诊断                  │
├────────────────────────────────────────────────┤
│  Node API（Express, server.ts → server/）        │
│  路由 · 任务系统 · 领域状态 · MCP · 事件流         │
├──────────────────────┬─────────────────────────┤
│  Python Worker       │  可选云端                 │
│  (:8800, 懒加载引擎)   │  Gemini TTS/转录 · Ollama │
│  Qwen3-TTS · Whisper │  （显式配置才启用）        │
├──────────────────────┴─────────────────────────┤
│  素材库 library/（领域 JSON = 事实源）+ SQLite     │
└────────────────────────────────────────────────┘
```

桌面形态：Electron 壳（asar 仅装壳）+ `extraResources` 真实磁盘分发 `dist/server.mjs`、`worker/` 等；壳内提供托管 uv Python 运行时、更新通道与脱敏诊断导出。

## 关键设计决策

1. **领域 JSON 是事实源，SQLite 只做运行时索引**：声音角色、批次、评审、验证、Profile 全部以原子写 JSON 落在 `library/` 对应目录（`voice-identities/`、`voice-design-batches/`、`voice-profiles/`）；`library/library.db` 只存任务行（幂等键、状态）与生成台账。删库重放以 JSON 为准（`VACUUM INTO` 备份）。
2. **不可变对象 + 幂等键**：设计批次、评审记录、发布版本一经写入不可修改（同键异指纹 → 409）；发布目录带 SHA-256 sidecar，同版本重复发布 → 409 `version_exists`。
3. **推理全部经 Worker 能力契约**：Node 不直接加载模型；`server/engines/`（undici 专用通道）调用 Worker 的四引擎（qwen_tts / voice_design / voice_clone / whisper_asr），引擎懒加载、闲置卸载、预热超时与 GPU 护栏在两端协商。推理时刻的模型身份（repo/revision/指纹/torch/device）捕获进 Profile Manifest。
4. **任务系统统一基座**（`server/jobs/`）：取消、恢复、幂等、进度、超时分段（warmup/inference）、崩溃窗口孤儿收养（已写盘未记账的 WAV 读回复用）；执行器按域注册（如 `stability-validation`）。
5. **消费只认已发布 Profile**：语音路由 `profile:<identityId>@<version>`；生成台账逐条记录 manifest_hash 与输入/输出 SHA-256，MCP 与 OpenAI 兼容端点复用同一闸门。

## 目录导览

| 路径 | 职责 |
|---|---|
| `server.ts` / `server/app.ts` | 入口与装配（默认仅监听 127.0.0.1） |
| `server/routes/` | 领域路由：voiceIdentities / voiceDesign / voiceLifecycle（AI 原创全链路）/ voiceSourceLifecycle（其余三来源）/ generateSpeech / openaiCompat / mcp / models / storage / events（SSE）等 |
| `server/jobs/` | 任务基座：runner / store（SQLite）/ engineLanes / executors |
| `server/engines/` | Worker 客户端与引擎路由：qwenWorker（undici 通道）、voiceProfileTts（profile: 路由与克隆消费门）、asr、geminiClient（可选云） |
| `server/lib/` | 共享内核：原子写、profileLicense、textConsistency（一致性口径，中文数字↔阿拉伯数字等价归一） |
| `server/mcp/` | MCP Streamable HTTP 服务器（5 工具） |
| `worker/` | Python FastAPI Worker：引擎加载、推理、doctor 自检 |
| `src/` | Web 前端（工作台页面、桌面桥接 `src/desktop/`） |
| `electron/` + `scripts/build-electron.mjs` + `electron-builder.yml` | 桌面壳与打包（extraResources 规则） |
| `library/`（运行时生成，不入 git） | 素材库：领域 JSON、批次音频、Profile、artifacts 生成物、library.db |

## 端点面

- Web/API：`/api/*`（REST）+ SSE 事件流（重放/心跳/轮询回退）；
- OpenAI 风格：音频生成与转录兼容端点（`server/routes/openaiCompat.ts`）；
- MCP：`/mcp`（Streamable HTTP，会话语义，工具见上）；
- Worker：`:8800`（health / 推理，仅本机）。

## 安全姿态（摘要）

单机/受控内网定位，无内置多用户认证（部署边界见 [docs/DELIVERY.md](DELIVERY.md)）；上传走大小与类型限制 + 路径安全（safeFs）；密钥仅经环境变量；完整口径见 [SECURITY.md](../SECURITY.md)。
