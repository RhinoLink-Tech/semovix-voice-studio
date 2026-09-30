# v0.1.0-alpha 发行物许可核查（已执行）

> 依据 [DISTRIBUTION_LICENSE_CHECKLIST.md](../../../DISTRIBUTION_LICENSE_CHECKLIST.md) 模板，对 2026-09-30 实际产物执行。
> 核查人：Claude（agent）｜正式发布签字见 ../sign-off.md §许可与来源。
> 产物：源码树（git v2026.09.25 @ PR-4 提交）+ 解包桌面构建 release/mac-arm64（--dir 结构验证，非安装包）。

## Required top-level files

- [x] `LICENSE` 为未经修改的 Apache License 2.0 标准正文（SHA-256 `cfc7749b…` 即 Apache-2.0 官方文本散列）
- [x] `NOTICE` 仅含适用的信息性署名
- [x] `THIRD_PARTY_NOTICES.md` 与发行物实际内容对应（release-candidate 草稿，随 PR-4 更新）

## Artifact inspection

- [x] 源码 commit/tag：见 ../release-baseline.md（tag v0.1.0-alpha.1）
- [x] 产物文件名与 SHA-256：见 ../build/checksums.txt（--dir 无整包安装产物，关键文件逐项）
- [x] 解包源码归档检查：git 跟踪面 329 文件，密钥/私钥扫描通过（../security/secret-scan.txt）
- [x] 解包 Electron 包资源检查：`Contents/Resources/app/` 含 LICENSE/NOTICE/THIRD_PARTY_NOTICES.md（与仓库逐字节一致，cmp 验证）
- [x] 随包 JS 依赖与版本：精简运行面 8 个直接依赖（../security/dependency-scan.txt），完整传递闭包 144 顶层项
- [x] 随包 Python 包与版本：包内仅 `worker/` 源码与锁文件（requirements-lock-macos.txt，91 项），Python 依赖首跑在用户机安装，不入包
- [x] 原生二进制：仅 better-sqlite3（arm64 重编译）与 Electron 自带框架；无 ffmpeg、无 uv 入包（首跑按需下载）
- [x] 模型权重未打包：`.safetensors`/`.pt`/`.wav`/`.mp3`/`.flac` 扫描命中为空（licensing/artifact-inspection.txt）
- [x] 无真人参考音频或授权文书入包：同上扫描为空；`library/` 为运行时产物不入 git
- [x] 字体/图标/截图/示例媒体条款已登记：无打包字体；图标为 Electron 默认 icns（应用图标未定制，已列遗留）；`public/voice-logo.png` 条款见 ASSET_LICENSES.md；无示例音频

## Scope checks

- [x] 以 Apache-2.0 发布的自有源码有已验证的来源基础：全库三层自动化初筛零复制证据 + 关键文件逐项审查（critical-file-review.md，待复核人签字生效）
- [x] 复制或修改的第三方源码逐项列明：自动化初筛未发现复制；设计层参考已在 CODE_PROVENANCE.md 与文件头声明
- [x] 模型代码与权重单列：model-license-review.md + docs/MODEL_AND_LICENSE_MATRIX.md（四权重许可已在线核对）
- [x] 外部云服务以服务而非再分发软件描述：Gemini TTS/转录（条款待所有者确认）、本地 Ollama
- [x] 品牌与商标权利不因 Apache-2.0 授予：TRADEMARKS.md、ASSET_LICENSES.md

## Build verification commands

全部通过（2026-09-30，逐项输出见 ../tests/ 与 ../build/）：
lint ✓ / test 392/392 ✓ / worker pytest 39 ✓ / build ✓ / smoke:local ✓ / smoke:desktop ✓ / package:dir ✓

## Release sign-off

- Release/version：0.1.0-alpha（tag v0.1.0-alpha.1）
- Commit：见 ../release-baseline.md
- Source archive SHA-256：发布归档生成时补
- Desktop artifact SHA-256：--dir 结构验证无整包；安装包发布时以 release/SHA256SUMS.txt 为准
- Reviewer：待人工（../sign-off.md）
- Review date：____
- Unresolved items：① CRITICAL_FILE_REVIEW 复核签字；② 云端服务条款确认；③ THIRD_PARTY_NOTICES 逐版本核实（现为草稿口径）；④ 应用图标未定制（Electron 默认 icns）
