# 能力状态矩阵（Capability Status）

> 基准日期：2026-09-30 ｜ 分支：`v2026.09.25` ｜ 提交：`7deb612`
>
> 本矩阵是仓库对外能力声明的唯一事实来源。README、Release 说明与页面文案不得宣称超出本矩阵的能力。Roadmap 项目一律不得写入"已实现"。

## 状态定义

| 状态 | 含义 |
|---|---|
| Implemented and verified | 代码存在，并完成明确验收（有可引用的验收记录） |
| Implemented, verification pending | 代码存在，但真实模型 / 跨平台 / 音质未完整验收 |
| Experimental | 实现存在，接口或结果可能变化 |
| Planned | 尚未实现 |

## 验证手段说明

- **CI**：使用伪模型，覆盖路由、状态机、幂等、Hash、文件安全与任务恢复；不下载真实权重，不能证明音质或真实模型运行通过。
- **手动 E2E**：2026-09-29 在一台 Apple Silicon macOS 开发机完成 P1 部分链路与 P2 的手动验收；2026-09-30 完成授权真人克隆全链路手动验收。均为单机、非跨平台。
- **Golden Path 真实验收**：尚未执行（发布基线 PR-3 范围），完成后本矩阵将据此升级状态。

## 矩阵

| 能力 | 状态 | 说明与验收记录 |
|---|---|---|
| AI 原创声音设计 | Implemented, verification pending | 四种来源之一；设计批次、候选生成、Manifest 归档均有 CI（伪模型）；2026-09-29 单机部分手动 E2E；真实音质未系统验收 |
| 授权真人克隆 | Experimental | 授权归档、参考音频、样本质量检查完整实现；2026-09-30 单机手动 E2E 全链路通过。因授权到期/撤销的运行时自动阻断未实现，Alpha 版本已禁用 Profile 正式发布与生产调用（发布门 `clone_publish_disabled_in_alpha`、消费门 `clone_profile_disabled_in_alpha`），补齐运行时策略后解除 |
| Provider 预置音色 | Implemented, verification pending | 从已连接 Worker 运行时读取官方 speaker ID；试听样音真实生成并归档；未逐 Provider 验收 |
| 导入 Voice Profile | Implemented, verification pending | 仅接受 ZIP（manifest + 单声道 16-bit PCM WAV）；路径安全、大小限制、SHA-256 校验有集成测试；真实外部 Profile 导入未逐例验收 |
| 匿名评审 | Implemented, verification pending | 随机匿名编号、七项评分、硬性否决、入围 1–3 名；集成测试覆盖校验规则 |
| 内容适配与重复生成检查 | Implemented, verification pending | 原"稳定性验证"。自动检查仅内容维度（成功生成、音频完整、时长、Whisper 转录、文字一致性、三次重复生成完成）；**不包含**声纹相似度、音色漂移或听感评分（设计如此，非缺失待补的自动能力） |
| Voice Profile 冻结 | Implemented, verification pending | 不可变 Manifest、SHA-256、审计日志、防覆盖（wx/COPYFILE_EXCL）；集成测试覆盖 |
| Profile 生产消费 | Implemented, verification pending | OpenAI 风格端点与 MCP 均可按 `profile:<identityId>@<version>` 消费已冻结 Profile；2026-09-29 单机手动 E2E |
| OpenAI 风格音频端点 | Implemented, verification pending | `POST /v1/audio/speech`、`POST /v1/audio/transcriptions`、`GET /v1/audio/voices` 子集；**非完整 OpenAI API 兼容**，仅音频相关 |
| MCP | Implemented, verification pending | MCP 服务与语音工具；2026-09-29 单机手动 E2E；工具集随版本可能调整 |
| 多轨混音 | Implemented, verification pending | 时间轴拼装、母带 EQ、压缩、峰值归一化、人声优先 Auto Ducking；**无** LUFS / True Peak 测量闭环（见 README 已知限制） |
| 转录 | Implemented, verification pending | 本地 Whisper（`openai/whisper-large-v3-turbo`，E2E 中实际使用）+ 可选 Gemini 云转录 |
| 模型下载 | Experimental | 首跑联网下载、doctor 体检、checkpoint 环境变量覆盖存在；下载管理器（进度、断点恢复、校验）未完整验收 |
| Electron 桌面壳 | Experimental | 开发模式可运行（`bun run dev:desktop`）；首次启动向导的手动验收未完成（截至 2026-09-29）；桌面能力边界仍可能变化 |
| macOS / Windows 安装包 | Experimental | `dist:mac` / `dist:win` 构建脚本存在；未在任何平台完成安装包构建、干净环境安装与启动验收 |
| 完全离线模式 | Experimental | 云端引擎未配置时如实返回不可用，本地链路可独立运行；整体离线场景未做系统验收，不应表述为"全部离线可用" |
| 实时语音对话 | Planned | 未实现。"双人对谈"为 TTS 双发音人合成模式，不是实时语音对话 |

## 维护规则

1. 升级为 `Implemented and verified` 必须附验收记录（日期、环境、执行人、归档位置，如 Golden Path 产物）。
2. 新增能力先入本矩阵，再进入 README；状态只能依据证据变更。
3. 本矩阵与 README、页面文案冲突时，以本矩阵为准并修正文案。
