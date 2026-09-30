# 更新日志（Changelog）

本项目所有可感知变更记录于此。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)；Alpha 期以功能与验收里程碑为主线。

## [0.1.0-alpha] - 2026-09-30

首个公开 Alpha。核心：本地优先的声音工作室——AI 原创声音设计、匿名评审、内容适配与重复生成检查、Voice Profile 冻结发布与再消费，全部经真实模型端到端验收（Golden Path）。

### 新增

- **声音角色与来源**：四种来源工作台（AI 原创设计 / 授权真人克隆 / Provider 预置音色 / 导入已有 Voice Profile）；来源配置持久化；角色生命周期交付（`21a58a7` 等）。
- **AI 原创设计链路**：不可变设计批次（4 方向 × 3 候选、fixedSeed、幂等键）、匿名评审（随机编号、七维评分、硬性否决、入围 1–3）、内容适配与重复生成检查（2 入围 × 5 场景 + 3 重复，Whisper 回听 + 文字一致性，中文数字 ↔ 阿拉伯数字等价归一 `90b73ed`）、发布决策与 V1.0 冻结（Manifest + SHA-256 sidecar + license 元数据）。
- **运行时任务系统**：统一任务基座——取消、恢复、幂等（`ae73e9c`）、进度与超时治理、崩溃窗口孤儿收养。
- **引擎与推理**：能力契约、模型锁定（revision/权重指纹入 Manifest）、加载/卸载生命周期、GPU 护栏（`81da545`）；慢设备长推理 undici 专用通道与克隆 max_new_tokens 封顶（`d3a9231`）；克隆参考音频静音预处理（`7deb612`）。
- **生产消费与溯源**：`profile:<identityId>@<version>` 语音路由、生成台账（manifest_hash + 输入/输出 SHA-256）、产物安全与迁移回滚（`fb76cdf`）。
- **桌面端（Electron）**：P0-A 桌面能力吸收与窗口状态持久化；托管 uv Python 运行时（锁、修复、重建，`0545af1`）；稳定/预览双更新通道与手动检查（`081cb52`）；诊断包脱敏导出（`ea96bcb`）；冷启动 Worker 先走 managed ensure（`c5ebd8d`）。
- **模型治理**：托管 HF 下载（断点续传、校验、磁盘检查、任务化，`b18f801`）+ 模型目录页（安装/卸载/删除与实时进度，`c80a644`）。
- **Profile 互操作**：可移植 Profile 包导出/导入（`b2125d5`）；Profile 许可元数据与试听水印（`256a5b4`）。
- **API 生态**：OpenAI 兼容音频端点（`89eaddc`）；MCP 服务器五工具（check_runtime / list_voice_profiles / generate_speech / get_generation / transcribe，`5aab082`）；SSE 事件流（重放、心跳、轮询回退，`3b2f879`）。
- **存储治理**：保留策略与存储清理（`3b1642e`）；ffmpeg 压缩音频输出（`a958d5e`）。
- **验收与证据**：Golden Path 驱动脚本与补充验证（`90b73ed`）；能力状态矩阵、来源审查模板与三层自动化初筛记录（`18706dc`、`02fc1fb`）。

### 变更

- 用户可见表述统一「稳定性验证」→「内容适配与重复生成检查」（内部任务 kind 不变，`18706dc`）。
- LUFS 预设改名并以 `targetLufs` 为保留字段（算法不动，`18706dc`）。
- 版本对齐 `0.1.0-alpha`，移除 `--passWithNoTests`（`a94caaf`）。

### 修复

- undici 推理通道绕过 fetch 桩致 17 例集成测试失败（`0faccdc`、`f0a7c54`）。
- 桌面冷启动回退 PATH python3 秒退（`c5ebd8d`）；冒烟模式同缺陷家族——绕过 managed ensure 直接启动 Worker（PR-4，随 v0.1.0-alpha.1）。
- 发行物未随附 LICENSE/NOTICE/THIRD_PARTY_NOTICES.md（LIC-07）→ staging 强制拷贝并 extraResources 落盘，缺失即中止打包（PR-4）。
- HF 逐文件下载进度/取消（`1f63e25`）；模型配置中心布局与重置流（`86b04cd`、`3aeda84`、`5e3f5f5`、`f66b7df`）。
- 真实模型下数字场景文字一致性 71.4% 系统性误判（TTS 中文数字 / Whisper 阿拉伯数字书写格式差异）→ 等价归一后 97.5%（`90b73ed`）。

### Alpha 期禁用（见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)）

- 授权真人克隆 Profile 的正式发布与生产调用（运行时授权策略未实现，`cd2fc5a`）。

### 许可

- 根目录落地未经修改的 Apache License 2.0 正文，附 NOTICE 与发行物核查清单（`6b9e275`）；模型权重、品牌资产与示例媒体不随 Apache-2.0 覆盖（见 [docs/MODEL_AND_LICENSE_MATRIX.md](docs/MODEL_AND_LICENSE_MATRIX.md)、[TRADEMARKS.md](TRADEMARKS.md)、[ASSET_LICENSES.md](ASSET_LICENSES.md)）。
- 四个默认权重的许可逐项对照 HuggingFace 模型页在线核对（Qwen3-TTS 三权重 Apache-2.0、whisper-large-v3-turbo MIT；PR-4，证据见 release-evidence/v0.1.0-alpha/licensing/）。

## 历史起点

`3598e71`（Initial commit）至 `21a58a7` 为闭源开发期（声音角色工作台、评审与验证工作区、国风旋律来源等），此后进入发布基线交付。
