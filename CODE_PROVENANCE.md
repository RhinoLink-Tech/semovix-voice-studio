# 代码来源审查（Code Provenance）

> **状态：逐文件人工审查未开始（责任人待指派）。2026-09-30 已完成针对 `debpalash/VoiceStudio` 的全库自动化初筛（记录见下），其结果属于证据，不构成"独立原创"结论。**
> 由发布基线执行包 PR-1 建立；逐文件结论必须由审查责任人填写，代码模型不得代填"独立原创"或其他未经核实的结论。
> 2026-09-30 Batch 01（Electron 壳 / 运行时监管 / 原生文件桥，15 文件）自动化证据包已完成，见下方「Batch 01 证据包」；其机器结果同样只是证据。

## 已确认事实（2026-09-30）

1. 仓库当前没有 `LICENSE`；最终许可证由项目所有者在来源审查结论明确后决定，任何人（包括代码模型）不得擅自选择 MIT、Apache-2.0 等。
2. [docs/001.md](docs/001.md) 记录了对 `debpalash/VoiceStudio`（AGPL-3.0）的能力与架构参考，项目内原则为"参考设计、独立实现、不直接复制代码"；**该原则尚未经逐文件审查验证**。
3. 审查判定规则：不得仅凭"技术栈不同"认定无复制，也不得仅凭"功能相似"认定存在复制；结论必须逐文件给出证据。
4. 2026-09-30 完成针对 VoiceStudio 的三层自动化初筛（全库级，非逐文件），未发现复制证据；方法、结果与边界见下方「自动化初筛记录」。该记录是证据，逐文件人工结论仍待审查责任人给出。

## 自动化初筛记录（2026-09-30，对比 VoiceStudio）

**对比对象**：本地克隆 `<voicestudio-repo>`（remote `debpalash/VoiceStudio`，HEAD `08a1592e`；本机路径经 `VOICESTUDIO_REPO_ROOT` 或 `scripts/provenance/collect-provenance-evidence.sh` 内候选位置解析，不入公开记录）；其根目录 LICENSE 实测为 AGPL-3.0 全文，与 docs/001.md 记载一致。

| 层 | 方法 | 覆盖范围 | 结果 |
|---|---|---|---|
| ① 字节级 | git 跟踪文件 md5 对撞（排除二进制与锁文件） | 本库 264 个文件 vs VoiceStudio 2946 个 | 完全相同 **0 个** |
| ② 同名文件 | 同名代码文件逐对行级多重集相似度（共同行数 ÷ 较大者行数） | 同名代码文件对 20 对 | 最高 42%，为 tsconfig.json（7 行编译器样板）；其次 Electron 入口 18%（Electron API 固定写法）、CI 配置 6%——均属技术栈必然样板 |
| ③ 特征行指纹 | 本库 ≥80 字符特征行（长代码、字面量、中文注释，去重 7286 条）在 VoiceStudio 全库做固定字符串搜索 | 本库全部 ts/tsx/py/js/jsx/css/sql/html 文件 | 逐字命中 **0 条** |

辅助检查：本库源码中无 AGPL/GNU/debpalash/ovsvoice 等版权头或标识残留；提及 VoiceStudio 的位置仅 docs/001.md 与两处注明"参考设计、独立实现"的代码注释（`server/lib/safeFs.ts` 等）。

**方法学边界（初筛不能替代逐文件审查的原因）**：

- 检不出小于 80 字符的碎片摘抄与换名重写（前者概率极低，后者按本文件判定规则本不构成复制）；
- 仅比对了本地克隆的当前版本（HEAD `08a1592e`），未覆盖 VoiceStudio 的其他历史版本；
- 仅覆盖 VoiceStudio 一个来源，未覆盖 npm/PyPI 依赖片段、官方示例等其他第三方来源。

按判定规则，上述结果只作为证据归档；记录表「分类」列的逐文件结论仍由审查责任人填写。

## Batch 01 证据包（2026-09-30，Electron 壳 / 运行时监管 / 原生文件桥）

**状态：自动化证据采集完成；逐文件人工分类未开始（`manual-review.csv` 全部人工字段保持待人工确认 / 待指派 / 未开始）。**

- 范围：`electron/main/`（含 `lib/` 9 文件中的 7 个范围文件）、`electron/preload/preload.ts`、`src/components/desktop/`（3 文件）、`src/desktop/fileDialogs.ts`、`server/lib/safeFs.ts` —— 共 15 文件（P0×7 / P1×8），见 [docs/provenance/batch-01/scope.txt](docs/provenance/batch-01/scope.txt)。
- 基线：Semovix `c5ebd8d2`（采集分支 audit/code-provenance-batch-01）vs VoiceStudio `08a1592e`（main，完整历史）；采集时间 2026-09-30T07:07:53Z。
- 脚本：`scripts/provenance/collect_batch01.py` v1.0.0（SHA-256 `808e06fc…c116dfa0`）+ 包装器 + 校验器，仅 Python 标准库；两次连跑输出除时间戳外逐字节一致（manifest 与 similarity-results 均验证）。
- 机器结果（证据，非结论）：244 对指标比对中 exact/normalized 哈希匹配 0、high-text 0、high-structure 0、独特注释命中 0；独特字面量命中 16 对次（4 文件机械触发 high，逐条为 Electron API 事件名 / dialog 属性 / Tailwind 工具类 / 状态词 / 1 条 data URL 模板字面量）；机器风险 high 4 / medium 0 / low 11 / blocked 0；P0 候选时间顺序全部 voicestudio-first，历史版本无更高相似峰值。
- 人工重点（机器观察）：`server/lib/safeFs.ts` 与 VS `backend/core/path_security.py` 的命名层相似（`resolveWithin/UnsafePathError` ↔ `resolve_within/UnsafePath`，与其文件头声明的「吸收、独立实现」一致，需逐行对照）；`electron/main/index.ts` 与 VS `blank-window-guard.ts` 有 1 行模板字面量逐字相同。
- 证据包：[docs/provenance/batch-01/README.md](docs/provenance/batch-01/README.md)（入口）｜[summary.md](docs/provenance/batch-01/summary.md)｜[review-notes.md](docs/provenance/batch-01/review-notes.md)｜[manual-review.csv](docs/provenance/batch-01/manual-review.csv)｜[out-of-scope-follow-up.md](docs/provenance/batch-01/out-of-scope-follow-up.md)。

## 审查范围（按优先级）

```text
electron/main/
electron/preload/
src/components/desktop/
server/engines/
server/routes/
server/jobs/
worker/
src/utils/audioEngine.ts
src/utils/multiTrackEngine.ts
public/
build/
```

## 每项记录字段

```text
路径
功能
首次引入提交
作者/来源
独立实现 / 官方示例 / 第三方复制 / 第三方修改
参考项目与版本
许可证
是否保留原版权声明
是否需要重写
审查责任人
审查状态
```

## 已知重点核查项（来自 docs/001.md 的参考记录）

- Electron 壳层（窗口、Preload、IPC 白名单）
- 后端进程监管（Node 服务与 Python Worker 的生命周期管理）
- 同源 `/api` 代理
- 首次启动向导
- 运行时状态中心
- 模型管理（doctor、checkpoint、能力合同）
- 原生文件导入导出

## 记录表

| 路径 | 功能 | 首次引入提交 | 作者/来源 | 分类 | 参考项目与版本 | 许可证 | 保留版权声明 | 需要重写 | 审查责任人 | 审查状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| electron/main/ | Electron 主进程与 Worker 监管 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| electron/preload/ | 安全 Preload 与 IPC 白名单 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| src/components/desktop/ | 桌面门控、首次启动向导、运行时状态中心 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| server/engines/ | Worker 引擎客户端（Qwen3-TTS / Whisper / Gemini） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| server/routes/ | 全部 HTTP API（生命周期、生成、MCP、OpenAI 风格端点等） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| server/jobs/ | 统一 Runtime Job 模型、执行器、恢复 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| worker/ | Python FastAPI Worker（模型加载、推理、ASR） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| src/utils/audioEngine.ts | 浏览器音频上下文与 WAV 编码 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| src/utils/multiTrackEngine.ts | 离线多轨混音与母带链（EQ/压缩/峰值归一化） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| public/ | 静态资产 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |
| build/ | 构建脚本与产物 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待指派 | 未开始 |

## 许可证决策门

只有同时满足以下条件，才能添加最终 `LICENSE`：

1. 关键目录来源已逐文件确认；
2. 第三方代码与资产已列入 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
3. 对 AGPL 来源代码（`debpalash/VoiceStudio`）的实际复用结论明确（存在 / 不存在，及范围）；
4. 模型权重许可与项目代码许可在 [docs/MODEL_AND_LICENSE_MATRIX.md](docs/MODEL_AND_LICENSE_MATRIX.md) 中分开说明；
5. 项目所有者完成许可证选择。
