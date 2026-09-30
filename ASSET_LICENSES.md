# 资产许可（Asset Licenses）

> Apache-2.0 覆盖**代码**。字体、图标、图像、音频等资产各自有独立边界（验收 LIC-05）。本文件按"仓库内 → 发行物 → 明确不分发"三档盘点。

## 仓库内资产

| 资产 | 位置 | 许可 |
|---|---|---|
| 应用标识 `voice-logo.png` | `public/` | © 项目所有者，保留所有权利；随应用分发用于标识目的，**不得**单独再利用或用于衍生项目标识（商标口径见 [TRADEMARKS.md](TRADEMARKS.md)） |
| 图标 | 经 `lucide-react` 依赖引入 | ISC（属第三方依赖，版本与通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，非仓库内拷贝） |
| 字体 | **无打包字体** | 界面使用系统字体栈；文档无内嵌字体 |
| 截图/宣传图 | **仓库内无** | 发布物料另行清点（发行物阶段） |

## 发行物中的资产边界（桌面打包）

- `electron-builder.yml` 的 `extraResources` 只分发 `dist/server.mjs`、`worker/`、`package.json` 与 LIC-07 三文件（LICENSE/NOTICE/THIRD_PARTY_NOTICES.md）；**不打包**模型权重、参考音频、用户素材；
- macOS 应用图标暂用 Electron 默认 `electron.icns`（应用图标未定制，正式版前补做 `voice-logo` 派生 icns）；
- entitlements 最小权限（`build/entitlements.mac.plist`）；
- 安装包必须随附 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`（验收 LIC-07，由 [DISTRIBUTION_LICENSE_CHECKLIST.md](DISTRIBUTION_LICENSE_CHECKLIST.md) 核查）。

## 明确不分发 / 不入 git 的内容

| 内容 | 处置 |
|---|---|
| 模型权重（Qwen3-TTS 系列、whisper-large-v3-turbo） | 使用方首跑从官方渠道下载；许可矩阵见 [docs/MODEL_AND_LICENSE_MATRIX.md](docs/MODEL_AND_LICENSE_MATRIX.md) |
| Golden Path 验收音频（候选/验证/生成 WAV） | 本地留存于 `artifacts/`，由 `artifacts/wav-manifest.sha256` 哈希锚定，**不入 git、不随发行物**（含真实生成的语音，避免以 Apache-2.0 口径扩散） |
| 用户素材库（`library/`：角色、批次、Profile、授权材料、生成台账） | 运行时产物，git 忽略；其权利属各用户/授权链，与本项目许可无关 |
| 官方示例音频 / 官方声音 | Alpha 未发布任何官方示例音频；未来发布时须在此登记来源与许可后方可分发 |

## 维护规则

新增任何二进制资产（图、音、字体、图标包）进仓库或打包配置时，必须同步登记本表并确认再分发权；无权再分发的资产改为运行时获取或文档指引。
