# v0.1.0-alpha 发布基线

> 本文件随 PR-4 提交入库；发布 Tag `v0.1.0-alpha.1` 指向包含本文件的提交（签字绑定精确 commit 见 sign-off.md）。
> 生成：2026-09-30（UTC）｜分支 `v2026.09.25`，合入 `main`。

## 版本性质

**Alpha（CONDITIONAL GO 候选）**：源码发布；桌面安装包不随本版分发（--dir 结构验证构建，见 build/）。核心 Golden Path 已通过；非核心能力已按能力矩阵降级标注（Experimental / Verification pending / Planned）。

## 基线内容

| 项 | 值 |
|---|---|
| 版本 | 0.1.0-alpha（package.json） |
| Tag | v0.1.0-alpha.1（annotated） |
| 前置基线 | PR-3 `90b73ed`（Golden Path 真实验收）+ PR-4 文档/修复批次 |
| 代码许可 | Apache-2.0（LICENSE，2026-09-30 所有者决定）+ NOTICE |
| 模型许可 | 四权重已在线核对（licensing/model-license-review.md），项目不分发权重 |
| 品牌/资产 | TRADEMARKS.md / ASSET_LICENSES.md（不在 Apache-2.0 覆盖内） |

## §2.3 QA 命令结果（2026-09-30，逐项原文见 tests/ 与 build/）

| 命令 | 结果 | 留证 |
|---|---|---|
| `bun install --frozen-lockfile` | ✓ | build/install.txt |
| `bun run lint` | ✓（修复 4 处脚本类型错误后） | tests/lint.txt |
| `bun run test` | ✓ 392/392（一次 KI-3 抖动重跑后绿，见 qa-notes） | tests/node-tests.txt |
| worker pytest | ✓ 39 passed | tests/python-tests.txt |
| `bun run build` | ✓（dist/server.mjs 389.7 KB） | build/build.txt |
| `bun run smoke:local` | ✓ SMOKE PASS 7/7 | tests/smoke-local.txt |
| `bun run smoke:desktop` | ✓ PASS（修复冒烟路径绕过 managed ensure 的真实缺陷后） | tests/smoke-desktop.txt |
| `bun run package:dir` | ✓（unsigned，LIC-07 三文件随包） | build/package-dir.txt |

## PR-4 批次内的真实修复（QA 抓出）

1. `electron/main/smoke.ts`：冒烟模式直接 `pythonWorkerSupervisor.start()`，managed 配置未先 ensure → 回退 PATH `python3`（无 uvicorn）秒退——与 c5ebd8d 修复的冷启动缺陷同类，冒烟路径漏改。改为走 `context.startConfiguredWorker()` 同路径。
2. `scripts/release.mjs` + `electron-builder.yml`：发行物此前不随附 LICENSE/NOTICE/THIRD_PARTY_NOTICES.md（LIC-07 缺口）——staging 强制拷贝三文件并 extraResources 落到 `Resources/app/`，缺失即中止打包。
3. `package.json` 补 description/author（消除 electron-builder 元数据告警）。

## 环境快照

见 build/environment.txt（macOS 27.0 arm64 / Apple M2 Max / node 24.10.0 / bun 1.3.14 / electron 44.4.5 / Python 3.12.14）。

## 遗留（人工动作，不阻塞代码合入）

- 五角色签字（sign-off.md）；
- 责任人重听 Golden Path 16 候选+验证音频与 3 条生成样本（sign-off.md §回听）；
- CRITICAL_FILE_REVIEW 复核人签字（代码作者不能是唯一复核人）；
- 云端 Gemini 条款由所有者确认。
