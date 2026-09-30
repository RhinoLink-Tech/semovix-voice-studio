# Semovix Voice Studio

Semovix Voice Studio 是一个本地优先的声音角色与音频生产工作台。它把声音来源配置、候选评审、内容适配检查、Voice Profile 版本发布和后续程序调用连接成一条可追溯流程。

> **当前为开发预览版（Alpha / Development Preview）。** 真实推理能力取决于模型权重、硬件、运行环境和外部服务配置；部分功能仍在验收中。各项能力的真实状态以 [能力状态矩阵](docs/CAPABILITY_STATUS.md) 为准，本 README 不做超出该矩阵的能力声明。

## 当前主流程

1. 创建声音角色并配置来源。四种来源共用同一工作台：AI 原创设计、授权真人克隆、Provider 预置音色、导入已有 Voice Profile。
2. AI 原创来源创建不可变声音设计批次，候选以随机匿名编号进入评审；评审记录七项分数、硬性否决与入围结果。
3. 入围候选进入**内容适配与重复生成检查**（页面与文档原称"稳定性验证"）：以候选 WAV 为参考音生成五组内容测试与三次重复生成，逐条保存 WAV、SHA-256、时长、波形摘要和 Whisper 回听转录。
4. 自动检查只覆盖内容维度（是否成功生成、音频完整、时长、转录与原文的文字一致性、重复生成是否完成）；音色、漂移与听感必须由责任人完整人工回听确认。系统不计算声纹相似度或音色稳定度得分。
5. 冻结发布复制最终参考音频与验证报告，写入不可变 Manifest、SHA-256 校验与审计记录。
6. 已发布的 Voice Profile 可经 OpenAI 风格音频端点或 MCP 在后续程序调用中消费。

授权真人克隆需要归档授权文件、有效期、用途边界与参考音频，没有有效归档授权不能上传样本或生成样音；系统提供授权材料的管理与留档，**不提供法律合规判断**。该来源当前为实验性：Alpha 版本禁用其 Profile 的正式发布与生产调用。

## 版本状态

- 开发预览版（0.1.0-alpha）；桌面安装包尚未构建与发布，当前从源码运行。
- CI 使用伪模型，只验证路由、状态机、幂等、Hash、文件安全与任务恢复，不能证明真实音质或真实模型运行通过。
- 真实模型验收（Golden Path）已于 2026-09-30 **完成并通过**：单台 Apple Silicon macOS 上 11 阶段全链路（设计 → 评审 → 检查 → 发布 → 消费），见 [Golden Path 验收](docs/GOLDEN_PATH.md) 与 [能力状态矩阵](docs/CAPABILITY_STATUS.md)。已知的限制与缺陷以 [KNOWN_ISSUES.md](KNOWN_ISSUES.md) 为准。

## 本地与云端边界

- **本地（默认）**：Qwen3-TTS 推理与 Whisper 转录由本机 Python Worker 执行，素材、批次、Profile 与授权材料保存在本机 `SEMOVIX_LIBRARY_DIR`；Node 服务默认仅监听 `127.0.0.1`。
- **云端（可选、需显式配置）**：Google Gemini TTS 与云端转录需设置 `GEMINI_API_KEY`；未配置时这些引擎如实返回不可用，不会静默切换或伪造结果。可选的本地 Ollama 用于转录后摘要等辅助推理。
- 本地优先不等于完全离线已验收：整体离线运行尚未做系统验收（见能力状态矩阵）。
- **默认不启用遥测**：不收集、不上传使用数据；若未来引入遥测，将以默认透明、可关闭的方式实现并在文档中明确说明。

## 安装与运行

依赖：Node.js 22+、bun（仓库附 `bun.lock`）、可运行 PyTorch 的 Python 3.10+ 环境。

```bash
bun install
bun run dev            # 单进程模式：http://127.0.0.1:3000 同时提供前端与 API
```

也可分离运行：

```bash
bun run dev:api        # API 服务 @ 127.0.0.1:3210
bun run dev:web        # Vite 浏览器预览，/api 代理到 3210（SEMOVIX_API_URL 可覆盖）
```

启动 Python Worker（Qwen3-TTS 与 Whisper）：

```bash
cd worker
./启动Worker.command
```

Worker 默认位于 `http://127.0.0.1:8800`（`SEMOVIX_WORKER_URL` 可覆盖）。全部环境变量见 [.env.example](.env.example)；启动前执行 `python worker/doctor.py`，逐项确认本地 checkpoint 或首跑下载需求。

## 模型与硬件要求

| 用途 | 默认权重（HuggingFace repo id） |
|---|---|
| 通用 TTS / 克隆推理与内容检查 | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` |
| AI 原创声音设计 | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` |
| 授权真人克隆（CustomVoice） | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` |
| 回听转录（ASR） | `openai/whisper-large-v3-turbo` |

- 权重首次运行时联网下载，也可通过 `.env` 指向本地目录；磁盘空间请按各权重大小预留。
- 当前开发与手动验收在一台 Apple Silicon macOS 上进行；其他硬件与平台未验收。
- 云端 Gemini TTS 为可选付费服务，使用前需自行配置与评估。

## 验证

```bash
bun run lint
bun run test                              # vitest（unit + integration，伪模型）
python3 -m pytest worker/tests/test_worker.py -q   # Worker 测试
bun run build
```

## 已知限制

完整清单与等级见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)，要点：

- 真实模型验收仅在单台 Apple Silicon macOS 开发机完成；Windows 安装包未构建、未验收。
- 授权真人克隆为**实验性来源**：Alpha 版本已禁用其 Voice Profile 的正式发布与生产调用（授权到期/撤销的运行时策略检查尚未实现）；授权归档、参考样本与来源验证可正常使用。模型更新后的漂移策略未实现（发布基线后续 PR 范围）。
- 同名模型权重更新后，不保证严格复现历史输出；推理时刻的模型身份会记录进 Manifest。
- 多轨混音执行 EQ、压缩、峰值归一化与人声优先 Auto Ducking，**没有** BS.1770 / EBU R128 的 LUFS 响度测量闭环，不能用于证明达到任何平台响度标准。
- 定位单机或受控内网：无内置身份认证、多租户与审计汇聚；上线多用户环境需按 [docs/DELIVERY.md](docs/DELIVERY.md) 的部署边界由基础设施补齐。
- CI 不下载真实权重，不证明音质、性能或跨平台可用性。

## 开源与第三方许可状态

- 根目录 [LICENSE](LICENSE) 为未经修改的 Apache License 2.0 标准正文（项目所有者 2026-09-30 决定），随附 [NOTICE](NOTICE) 与发行物核查清单 [DISTRIBUTION_LICENSE_CHECKLIST.md](DISTRIBUTION_LICENSE_CHECKLIST.md)。
- **许可证文件就位不等于正式发布**：逐文件来源审查尚未完成（[CODE_PROVENANCE.md](CODE_PROVENANCE.md)），审查完成前不以 Apache-2.0 正式发布相应代码，也不对代码原创性做超出该审查的声明。
- 本项目在能力与架构层面参考了 `debpalash/VoiceStudio`（AGPL-3.0）的公开设计（记录见 [docs/001.md](docs/001.md)）；针对其全库自动化初筛未发现复制证据，关键文件逐项审查见 [docs/provenance/CRITICAL_FILE_REVIEW.md](docs/provenance/CRITICAL_FILE_REVIEW.md)，逐文件人工结论以 [CODE_PROVENANCE.md](CODE_PROVENANCE.md) 为准。
- 第三方依赖清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（release-candidate 草稿，逐项版本与许可待对实际发行物核实），模型权重许可矩阵见 [docs/MODEL_AND_LICENSE_MATRIX.md](docs/MODEL_AND_LICENSE_MATRIX.md)；模型代码、模型权重与云服务条款不由根目录 Apache-2.0 覆盖，品牌与名称见 [TRADEMARKS.md](TRADEMARKS.md)，资产边界见 [ASSET_LICENSES.md](ASSET_LICENSES.md)。

## 安全与授权提示

- 本项目定位**单机或受控内网**：无内置多用户身份认证；公网/共享网络部署需自行补齐基础设施边界（[docs/DELIVERY.md](docs/DELIVERY.md)）。
- 授权真人克隆需要归档有效授权材料（文件、有效期、用途边界）；系统提供留档与验证，**不提供法律合规判断**，且 Alpha 期禁用其 Profile 正式发布与生产调用。
- 安全策略与漏洞报告渠道见 [SECURITY.md](SECURITY.md)（请勿在公开 issue 报告安全问题）；贡献需签署 DCO（[CONTRIBUTING.md](CONTRIBUTING.md)）。

## 受控环境交付

```bash
bun run build
NODE_ENV=production node dist/server.mjs   # 或 bun run start:production
```

服务默认仅监听回环地址。受控内网部署应由反向代理承担 TLS 与身份认证，并将 Node 服务和 Worker 保持在同一受限网络；Worker 端口不能直接暴露。发布前应执行完整测试集与 `bun run smoke:local`。
