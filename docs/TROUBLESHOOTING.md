# 故障排查（Troubleshooting）

> 按「现象 → 原因 → 处置」组织。涉及已知限制而非故障的问题见 [KNOWN_ISSUES.md](../KNOWN_ISSUES.md)。

## 安装与启动

### `bun: command not found` / `node: command not found`

包管理器不在默认 PATH。`export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"`（macOS Homebrew 场景），或按官方方式安装。

### API 起不来 / 端口被占

- 默认端口：单进程 3000、分离 API 3210、Worker 8800。`lsof -ti :<端口> -sTCP:LISTEN` 查占用；
- **3001 端口被无关进程占用属正常冲突**（历史默认口），换 `PORT=xxxx bun run dev:api` 即可，无需杀他人进程；
- 集成测试假设 8800 无真实 Worker（见 KI-3），跑发布级测试前先停 dev stacks。

### 本机代理导致 localhost 请求 502

系统代理会拦截 `python3 urllib` 对 127.0.0.1 的请求（观察到 502 空响应）。处置：`curl` 验证、或为 localhost 配置 `no_proxy`。

## Python Worker

### 引擎一直 `cold` / 首次调用很慢

引擎为**懒加载**：VoiceDesign 首载 ≈45s（4.2G 权重），voice_clone/whisper 预热 ≤20s。查进度：

```bash
curl -s http://127.0.0.1:8800/health | python3 -m json.tool
```

`loadAttempts` 增长而 `state` 回 `cold` 说明加载失败，看 `error` 字段与 Worker 日志。

### `python worker/doctor.py` 报缺依赖

开发机使用独立 conda 环境（PyTorch 等）。确认用对了解释器（`which python`），桌面端则依赖托管 uv 运行时，可在应用内修复/重建（P1 #31 能力）。

### 桌面冷启动 Worker 秒退

已在 `c5ebd8d` 修复：冷启动先走 managed ensure 再考虑回退。仍出现时导出脱敏诊断包（设置 → 诊断导出）排查。

## 声音生产链路

### 设计批次永远停在 `queued`

多半是手工删除过 `library/voice-design-batches/` 内目录触发的编号复用回放（KI-2）。**不要手工删库内目录**；已卡死的批次记录在案，等待批次治理功能。

### 内容检查一致性偏低 / 数字场景误判

文字一致性已内置中文数字 ↔ 阿拉伯数字等价归一（「二零二六」≡「2026」）。若仍低于 88：先核对是否同音字差异（如「复现/复线」，属真实 ASR 噪声）；万/亿级超大数不在归一范围，会按字符比对如实判罚。

### 克隆来源无法发布 Profile

Alpha 期**有意禁用**（KI-1，409 `clone_publish_disabled_in_alpha`）：授权归档与试听可用，正式发布等待运行时授权策略版本。

### 已发布 Profile 找不到 / 无法消费

- 语音名格式必须是 `profile:<identityId>@<版本>`（如 `profile:voice-xxx@V1.0`）；
- 消费目录只含**已发布** Profile（草稿/候选不进入，GP-13）；
- 重复发布同版本会 409 `version_exists`——版本不可覆盖，需新版本号。

## 桌面与更新

- 更新通道分稳定/预览（P1 #40），手动检查在设置内；
- 打包目录模式：`bun run package:dir`；正式安装器 Alpha 期未发布。

## 诊断信息收集

- Worker：`/health`（引擎状态）+ Worker 进程日志；
- API：请求日志与任务状态（`GET /api/jobs`）；
- 桌面：设置 → 诊断包导出（已脱敏）；
- 证据链复跑：[GOLDEN_PATH.md](GOLDEN_PATH.md)（含 `GP_RESUME` 续跑）。

提交问题时请附带以上脱敏信息，并确认不含密钥、授权材料与未公开音频。
