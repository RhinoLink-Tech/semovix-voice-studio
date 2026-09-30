# 模型与许可矩阵（Model and License Matrix）

> **状态：本地权重许可已于 2026-09-30 逐项对照 HuggingFace 模型页核对（核对人与链接见下表）；云端服务条款仍待项目所有者确认。**

## 原则

1. **模型权重许可与项目代码许可是两件事**，分别决定，分别声明。
2. 本仓库不分发任何模型权重；权重由使用方首次运行时从官方渠道下载，或自行指定本地目录。
3. 任何权重的许可结论未确认前，不对其再分发、商用或修改做出承诺。

## 本地模型（经 Python Worker）

| 模型（HuggingFace repo id） | 用途 | 获取方式 | 权重许可 | 再分发 | 备注 |
|---|---|---|---|---|---|
| Qwen/Qwen3-TTS-12Hz-1.7B-Base | 通用 TTS、克隆推理、内容检查 | 首跑下载或 `SEMOVIX_TTS_CKPT` / `SEMOVIX_VOICE_CLONE_CKPT` 指向本地 | **Apache-2.0**（2026-09-30 核对，[模型页](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)） | 许可允许；本项目不分发，使用方自行从官方渠道获取 | 推理时刻的模型指纹与 revision 记录入 Profile Manifest |
| Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign | AI 原创声音设计 | 首跑下载或 `SEMOVIX_VOICE_DESIGN_CKPT` | **Apache-2.0**（2026-09-30 核对，[模型页](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign)） | 同上 | 与 Base/CustomVoice 不混用 |
| Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | 授权真人克隆 | 首跑下载或 `SEMOVIX_TTS_CKPT` | **Apache-2.0**（2026-09-30 核对，[模型页](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)） | 同上 | |
| openai/whisper-large-v3-turbo | 回听转录（ASR） | 首跑下载或 `SEMOVIX_ASR_MODEL` 覆盖 | **MIT**（2026-09-30 核对，[模型页](https://huggingface.co/openai/whisper-large-v3-turbo)） | 同上 | transformers pipeline 加载 |

Revision 锁定：`SEMOVIX_*_REVISION` 环境变量可锁定权重版本；未锁定时以拉取时点的默认分支为准，历史输出不保证复现。

## 云端服务（可选）

| 服务 | 用途 | 触发条件 | 服务条款与数据边界 | 备注 |
|---|---|---|---|---|
| Google Gemini TTS（gemini-2.5 系列 preview） | 云端语音合成 | 显式配置 `GEMINI_API_KEY` 并选择对应引擎 | 待确认（以 Google API 条款为准） | 未配置时如实返回不可用 |
| Google Gemini 转录 | 云端转录 | 同上 | 待确认 | 同上 |
| 本地 Ollama（可选） | 转录后摘要 / 情绪 / 标签 | 显式配置 `OLLAMA_URL` | 本地推理，不出网 | 默认 `127.0.0.1:11434` |

## 填写责任

- 权重许可列：2026-09-30 由审查执行人（Claude agent）对照各模型 HuggingFace 页面在线核对填写；正式发布前建议责任人抽查任一模型页复核。
- 云端服务条款列：由项目所有者确认可接受的使用范围后填写。
- 本矩阵与代码行为不一致时，以事实为准并同步修正。
