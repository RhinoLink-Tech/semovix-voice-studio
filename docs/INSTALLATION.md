# 安装指南（Installation）

> 适用：v0.1.0-alpha。当前真实模型验收仅在 Apple Silicon macOS 完成；Windows 未构建安装包、未验收（见 [KNOWN_ISSUES](../KNOWN_ISSUES.md) 与能力状态矩阵）。桌面安装包尚未发布，以下均为从源码运行。

## 前置依赖

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | 22+ | API/构建 |
| bun | 任意近期版本 | 包管理与脚本（仓库附 `bun.lock`） |
| Python | 3.10+ 且可运行 PyTorch | Worker 推理；开发机使用 conda 环境 |
| 磁盘 | ≥12G 余量（建议更多） | 模型权重：Base ≈4.2G、VoiceDesign ≈4.2G、whisper-large-v3-turbo ≈1.5G，另加素材库 |
| 网络 | 首跑需要 | 权重从 HuggingFace 官方渠道下载；之后可完全本地 |

## 源码运行（Web + API）

```bash
bun install                 # 安装依赖
bun run dev                 # 单进程：http://127.0.0.1:3000（前端 + API）
```

分离模式（开发推荐）：

```bash
bun run dev:api             # API @ 127.0.0.1:3210（PORT 可覆盖）
bun run dev:web             # Vite 预览，/api 代理到 3210（SEMOVIX_API_URL 可覆盖）
```

## 启动 Python Worker（推理引擎）

```bash
cd worker
./启动Worker.command        # macOS
# 或：python app.py         # 默认 http://127.0.0.1:8800（SEMOVIX_WORKER_URL 可覆盖）
```

- 启动前自检：`python worker/doctor.py`——逐项确认本地 checkpoint 或首跑下载需求；
- 首次调用各引擎时**懒加载**权重（VoiceDesign 首载 ≈45s，voice_clone/whisper 预热 ≤20s，视机器而定）；闲置 30 分钟自动卸载；
- 全部环境变量见 [.env.example](../.env.example)：权重本地目录（`SEMOVIX_*_CKPT`）、revision 锁定、库目录（`SEMOVIX_LIBRARY_DIR`）、可选云端 `GEMINI_API_KEY` 等。

## 模型权重

| 用途 | 默认权重 | 环境变量覆盖 |
|---|---|---|
| 通用 TTS / 克隆推理与内容检查 | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `SEMOVIX_TTS_CKPT` |
| AI 原创声音设计 | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `SEMOVIX_VOICE_DESIGN_CKPT` |
| 授权真人克隆（CustomVoice） | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | `SEMOVIX_VOICE_CLONE_CKPT` |
| 回听转录（ASR） | `openai/whisper-large-v3-turbo` | `SEMOVIX_ASR_MODEL` |

- 权重**不随仓库分发**，许可边界见 [docs/MODEL_AND_LICENSE_MATRIX.md](MODEL_AND_LICENSE_MATRIX.md)；
- Web 端「模型目录」页可安装/卸载/删除并查看实时进度（桌面端同样可用）。

## 桌面端（Electron，开发模式）

```bash
bun run dev:desktop         # 构建 Electron 壳并以开发模式启动
bun run desktop:prod        # 生产构建 + 启动
bun run package:dir         # 目录打包（不产出安装器）
```

桌面端内建**托管 Python 运行时**（uv 管理，含锁、修复与重建），冷启动 Worker 优先走托管环境，不依赖系统 PATH 中的 python3；模型缓存位于 `~/Library/Application Support/Semovix Voice Studio/cache/huggingface`。

## 验证安装

```bash
bun run lint && bun run test        # 392 项测试（伪模型）
python3 -m pytest worker/tests -q   # Worker 测试
curl -s http://127.0.0.1:8800/health | head -c 200   # Worker 健康（引擎状态）
```

跑通真实链路的方式见 [GOLDEN_PATH.md](GOLDEN_PATH.md)。

## 常见问题

见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。安装失败且文档未覆盖时，按 [SECURITY.md](SECURITY.md) 的口径提交问题（勿粘贴密钥与授权材料）。
