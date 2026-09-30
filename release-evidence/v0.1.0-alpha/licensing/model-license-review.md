# v0.1.0-alpha 模型许可审查记录

> 审查人：Claude（agent，在线核对）｜日期：2026-09-30 ｜权威文档：[docs/MODEL_AND_LICENSE_MATRIX.md](../../../docs/MODEL_AND_LICENSE_MATRIX.md)（本文件为发布时点留证）

## 方法

逐个访问各权重 HuggingFace 模型页，以页面标注的 license 为准（非记忆/惯例）。核对时间 2026-09-30（UTC）。

## 结论

| 模型 | 页面标注许可 | 核对入口 |
|---|---|---|
| Qwen/Qwen3-TTS-12Hz-1.7B-Base | apache-2.0 | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base |
| Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign | apache-2.0 | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign |
| Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | apache-2.0 | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice |
| openai/whisper-large-v3-turbo | mit | https://huggingface.co/openai/whisper-large-v3-turbo |

## 与发行物的关系

- 本项目**不分发任何权重**：安装包（--dir 结构验证）与源码发行物均不含 `.safetensors`/`.pt` 等权重文件（见 artifact-inspection.txt 的禁分发扫描，命中为空）；
- 权重由使用方首跑从官方渠道下载（`HF_HOME` 指向托管缓存），或经 `SEMOVIX_*_CKPT` 指向本地；
- 上述许可均允许再分发与商用，但项目维持不分发立场（避免版本漂移与体积），此立场不构成许可义务。

## 待办（不阻塞 Alpha 源码发布）

- 云端 Gemini TTS / 转录的服务条款与数据边界：待项目所有者确认（矩阵「云端服务」表仍为待确认）；
- 正式发布前建议责任人抽查任一模型页复核本表（与 CRITICAL_FILE_REVIEW 相同的"作者 ≠ 唯一复核人"精神）。
