# QA 留证备注（诚实口径补记）

> 本文件记录 QA 套跑（2026-09-30）中与"一次全绿"不符的事实，均已在正文留证或修复。

## 1. node 集成测试一次 391/392（KI-3 抖动）

- 现象：`voiceAdditionalSources.api.test.ts` 单独失败一次——机器上同时运行着真实 Worker（:8800），属 KNOWN_ISSUES KI-3 已知抖动家族；
- 处置：原样重跑一次即 392/392 全绿（tests/node-tests.txt 存绿跑原文）；
- 结论：留证文件以绿跑为准，抖动发生事实在此登记，不掩盖。

## 2. smoke:desktop 首跑失败（真实缺陷，已修复）

- 现象：`worker-status` 检查失败——冒烟模式直接 `pythonWorkerSupervisor.start()`，managed 配置未先 ensure，解释器回退 PATH `python3`（Homebrew 3.14，无 uvicorn）秒退（worker.log：`No module named uvicorn`）；
- 修复：`electron/main/smoke.ts` 改走 `context.startConfiguredWorker()`（与 c5ebd8d 冷启动修复同路径），失败时如实 record 而非漏记；
- 复跑：SMOKE DESKTOP PASS（tests/smoke-desktop.txt 存修复后原文；首跑失败原文已被复跑覆盖，事实在本文件与 CHANGELOG 登记）。

## 3. smoke 会话 Python 解释器配置（披露）

- 冒烟沙盒（smoke-session userData）的 Python 配置为 `kind=bin`，指向 `~/anaconda3/envs/qwen3-tts/bin/python`——与生产 Worker（:8800）同一解释器环境；
- 原因：managed 路径在冒烟沙盒内会触发全新 venv 供应（多 GB torch 栈、无 uv 缓存），不适合作为冒烟步骤；bin 配置等价于向导中"使用自有 Python"的用户选择；
- 范围声明：本次留证验证的是 bin 配置分支；managed 分支与冷启动 bootstrap 共用 `startConfiguredWorker()`（c5ebd8d 已在桌面手动 E2E 验证），未在本冒烟中重复触发。

## 4. package:dir 首跑缺 LIC-07 文件（真实缺口，已修复）

- 现象：首打包 `Resources/app/` 不含 LICENSE/NOTICE/THIRD_PARTY_NOTICES.md；
- 修复：release.mjs staging 强制拷贝（缺失即 exit 1）+ electron-builder.yml extraResources 三条目；
- 复跑验证：三文件随包且与仓库逐字节一致（cmp，见 licensing/artifact-inspection.txt）。build/package-dir.txt 存修复后原文。

## 5. 其他如实声明

- environment.json（Golden Path 阶段 0）记录的 apiServerProcessStartedAt 探测到 :3001（用户 vite），真实 API 为 :3210——驱动已修复探测端口，历史留证按原样保留（acceptance-report.md §1 勘误）；
- 打包为 unsigned（无 Developer ID 证书），latest.json 已如实标注；应用图标使用 Electron 默认 icns（未定制，列遗留项）。

## 6. 公开前机器路径脱敏（2026-09-30，tag 重定位前）

- 动机：留证文件中的本机绝对路径会暴露用户名与个人卷宗命名，不适合进入公开仓库；
- 范围：13 个留证文件（artifacts/golden-path* 的 driver.log / environment.json / generations-final.json / mcp-results 与本目录 4 个工具原文）；
- 变换规则（仅路径，状态/哈希/时间戳/URL 端口一律未动；原路径字面量不再写入公开文档，此处以描述指代）：
  - 本机仓库绝对路径（含用户名与工作区目录） → `<repo>`
  - 其余本机家目录前缀 → `~`
  - 个人外置卷名（模型权重存放盘） → `<model-volume>`
- 复查：替换后对三种原路径全库检索零命中（本节以描述指代原串，同样不计入）；HuggingFace repo id 等公开标识不受影响；
- 诚实口径：这是对已提交留证的事后脱敏，事实在此登记；git 历史中的早期提交仍含原路径（见 release-baseline 遗留说明，历史是否重写由所有者决定）。
