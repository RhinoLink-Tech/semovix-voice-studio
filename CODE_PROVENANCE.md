# 代码来源审查（Code Provenance）

> **状态：审查未开始。本文件当前只包含模板与已确认事实，不含任何结论。**
> 由发布基线执行包 PR-1 建立；逐文件结论必须由审查责任人填写，代码模型不得代填"独立原创"或其他未经核实的结论。

## 已确认事实（2026-09-30）

1. 仓库当前没有 `LICENSE`；最终许可证由项目所有者在来源审查结论明确后决定，任何人（包括代码模型）不得擅自选择 MIT、Apache-2.0 等。
2. [docs/001.md](docs/001.md) 记录了对 `debpalash/VoiceStudio`（AGPL-3.0）的能力与架构参考，项目内原则为"参考设计、独立实现、不直接复制代码"；**该原则尚未经逐文件审查验证**。
3. 审查判定规则：不得仅凭"技术栈不同"认定无复制，也不得仅凭"功能相似"认定存在复制；结论必须逐文件给出证据。

## 审查范围（按优先级）

```text
electron/main/
electron/preload/
src/components/desktop/
server/engines/
server/routes/
server/jobs/
worker/
src/utils/audioEngine.ts
src/utils/multiTrackEngine.ts
public/
build/
```

## 每项记录字段

```text
路径
功能
首次引入提交
作者/来源
独立实现 / 官方示例 / 第三方复制 / 第三方修改
参考项目与版本
许可证
是否保留原版权声明
是否需要重写
审查责任人
审查状态
```

## 已知重点核查项（来自 docs/001.md 的参考记录）

- Electron 壳层（窗口、Preload、IPC 白名单）
- 后端进程监管（Node 服务与 Python Worker 的生命周期管理）
- 同源 `/api` 代理
- 首次启动向导
- 运行时状态中心
- 模型管理（doctor、checkpoint、能力合同）
- 原生文件导入导出

## 记录表

| 路径 | 功能 | 首次引入提交 | 作者/来源 | 分类 | 参考项目与版本 | 许可证 | 保留版权声明 | 需要重写 | 审查责任人 | 审查状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| electron/main/ | Electron 主进程与 Worker 监管 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| electron/preload/ | 安全 Preload 与 IPC 白名单 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| src/components/desktop/ | 桌面门控、首次启动向导、运行时状态中心 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| server/engines/ | Worker 引擎客户端（Qwen3-TTS / Whisper / Gemini） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| server/routes/ | 全部 HTTP API（生命周期、生成、MCP、OpenAI 风格端点等） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| server/jobs/ | 统一 Runtime Job 模型、执行器、恢复 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| worker/ | Python FastAPI Worker（模型加载、推理、ASR） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| src/utils/audioEngine.ts | 浏览器音频上下文与 WAV 编码 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| src/utils/multiTrackEngine.ts | 离线多轨混音与母带链（EQ/压缩/峰值归一化） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| public/ | 静态资产 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| build/ | 构建脚本与产物 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |

## 许可证决策门

只有同时满足以下条件，才能添加最终 `LICENSE`：

1. 关键目录来源已逐文件确认；
2. 第三方代码与资产已列入 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
3. 对 AGPL 来源代码（`debpalash/VoiceStudio`）的实际复用结论明确（存在 / 不存在，及范围）；
4. 模型权重许可与项目代码许可在 [docs/MODEL_AND_LICENSE_MATRIX.md](docs/MODEL_AND_LICENSE_MATRIX.md) 中分开说明；
5. 项目所有者完成许可证选择。
