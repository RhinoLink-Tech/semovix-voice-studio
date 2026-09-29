# Semovix Voice Worker（Python FastAPI）

独立 Python 进程承载本地引擎，Node 后端（Express）只与本 Worker 通信（硬性约束 #14）。
三个引擎在同一进程内**独立懒加载**：进程秒起，显式预热对应端点时才加载模型。

| 引擎 | 模型 | 设备 |
|---|---|---|
| Qwen3-TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`（HF repo id 或本地目录） | MPS / CUDA / CPU 自动选择 |
| Qwen3-TTS VoiceDesign | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`（HF repo id 或本地目录） | MPS / CUDA / CPU 自动选择 |
| Qwen3-TTS Base（真人克隆） | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（HF repo id 或本地目录） | MPS / CUDA / CPU 自动选择 |
| Whisper | `openai/whisper-large-v3-turbo` | MPS / CUDA / CPU 自动选择 |

## 环境体检

```bash
python worker/doctor.py        # 逐项 PASS/WARN/FAIL；有 FAIL 时非零退出
```

检查 Python / torch 与加速设备 / qwen_tts / transformers / librosa / TTS checkpoint /
FFmpeg / 端口 8800 / 可写目录。新机器部署建议先跑体检再启动。

## 依赖安装

```bash
pip install -r requirements-base.txt     # 全平台基础依赖（含引擎层）
pip install -r requirements-macos.txt    # macOS（Apple Silicon，MPS）
pip install -r requirements-cuda.txt     # Linux/Windows（NVIDIA GPU）
```

### 锁文件（桌面版托管运行时，P1 #31）

桌面版「自动安装托管运行时」用 `uv pip sync` 按**锁定版本**安装依赖
（Python 3.12，uv 二进制版本与 SHA256 在 `electron/main/lib/managedRuntime.ts` 锁定）：

- `requirements-lock-macos.txt` — macOS（Apple Silicon）
- `requirements-lock-cuda.txt` — Linux/Windows（CUDA，含 `--extra-index-url` 指向 PyTorch cu121 索引）

升级依赖时由维护者重新生成（无仓库脚本，命令记录在文件头注释中）：

```bash
uv pip compile requirements-macos.txt -o requirements-lock-macos.txt
uv pip compile requirements-cuda.txt -o requirements-lock-cuda.txt \
  --python-platform x86_64-unknown-linux-gnu --python-version 3.12
```

## 启动

双击 `启动Worker.command`（自动按优先级解析解释器：`SEMOVIX_PYTHON_BIN` >
`SEMOVIX_CONDA_ENV`（默认 `qwen3-tts`，经 `conda run`）> PATH 上的 `python3`），或：

```bash
cd worker
python -m uvicorn app:app --host 127.0.0.1 --port 8800
```

Node 侧默认连接 `http://127.0.0.1:8800`，可用 `SEMOVIX_WORKER_URL` 覆盖。Worker 会依次读取项目根目录 `.env` 和 `worker/.env`，并保留进程已经传入的环境变量；因此 Node 与 Worker 可以共享 checkpoint 路径配置。
启动器会在监听端口前验证 `torch`、`qwen_tts`、`transformers` 与 `librosa`。任一依赖缺失会直接退出并提示安装命令，不会启动一个只能返回引擎错误的半可用 Worker。
为兼容部分 Python 3.12 的 librosa/numba 组合，启动器默认设置 `NUMBA_DISABLE_JIT=1`，避免导入阶段的 Numba 缓存定位错误；该设置只影响 librosa 的可选 JIT 缓存，不影响 Qwen 的 PyTorch 推理。已验证兼容的环境可设 `SEMOVIX_NUMBA_DISABLE_JIT=0` 覆盖。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 引擎冷启动状态 `{state: cold\|loading\|ready\|error}`（永不触发加载） |
| POST | `/warmup/qwen` | 显式预热 TTS：ready→200；cold/loading→202 {retry}；error→503 {retry} 并自动重载 |
| POST | `/warmup/voice-design` | 独立预热 VoiceDesign；不会复用 CustomVoice 权重 |
| POST | `/warmup/voice-clone` | 独立预热 Base 真人克隆模型 |
| POST | `/warmup/whisper` | 同上（ASR） |
| GET | `/voices` | **Qwen 官方 speaker 精确 ID**（模型运行时 `get_supported_speakers()`，如 `uncle_fu`；硬性约束 #6）；未就绪 → 503 engine_not_ready |
| POST | `/tts/qwen` | `{"text","speaker","language"?,"instruct"?}` → `audio/wav` 字节流（非 Base64；硬性约束 #7） |
| POST | `/tts/voice-design` | `{"text","instruct","language"?,"seed"?}` → `audio/wav` 字节流；仅使用 VoiceDesign 模型 |
| POST | `/tts/voice-clone` | multipart：`file`、`reference_text`、`text`、`language` → `audio/wav`；仅使用 Base 模型 |
| POST | `/asr/whisper` | multipart `file` + `language=auto|zh|en` → `{"transcript","language","duration"}` |

错误结构统一为 `{"detail": {"error", "code", "engine", ...}}`：
`engine_not_ready`（503）、`unsupported_speaker`（400，附官方 `speakers`）、
`unsupported_language`（400）、`tts_failed` / `asr_failed`（502）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEMOVIX_TTS_CKPT` | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | Qwen3-TTS checkpoint（HF repo id 或本地目录） |
| `SEMOVIX_VOICE_DESIGN_CKPT` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | VoiceDesign checkpoint（HF repo id 或本地目录） |
| `SEMOVIX_VOICE_CLONE_CKPT` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 真人克隆 Base checkpoint（HF repo id 或本地目录） |
| `SEMOVIX_ASR_MODEL` | `openai/whisper-large-v3-turbo` | Whisper 模型 |
| `SEMOVIX_WORKER_URL` | `http://127.0.0.1:8800` | Node 侧连接地址（server/config.ts） |
| `SEMOVIX_WORKER_PORT` | `8800` | Worker 监听端口（启动器读取） |
| `SEMOVIX_PYTHON_BIN` | — | 启动器用：解释器绝对路径 |
| `SEMOVIX_CONDA_ENV` | `qwen3-tts` | 启动器用：conda 环境名 |

## 设计要点

- **官方音色目录以引擎为唯一权威**：speaker 列表来自模型运行时，服务端不做任何
  persona→speaker 映射；非官方 ID 一律 400（硬性约束 #5/#6）。
- **音频走文件流**：TTS 响应为 WAV 字节，ASR 请求为 multipart 上传（硬性约束 #7）。
- 语速变速（WSOLA）在 Node 侧完成，Worker 只负责原生合成。
- **无机器专属路径**：仓库内不写死任何绝对路径；本机差异全部走环境变量。
