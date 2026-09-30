# Batch 01 摘要（机器证据汇总，非来源结论）

- **范围**：Electron 壳、运行时监管、Preload/IPC、首次启动与运行时状态、原生文件桥、
  安全路径处理 —— 15 个文件（P0×7 / P1×5 / 组件×3），全部存在于基线提交。
- **基线**：Semovix `c5ebd8d220046afd52df34e3ec4982f3fae887b3`（分支
  audit/code-provenance-batch-01）vs VoiceStudio `08a1592e3cb9b4c36beef5fa3185ec2313bb1fea`
  （main，完整历史 3381 commits，根 LICENSE 实测 AGPL-3.0）。
- **方法**：职责候选映射（种子 + 同名 + 符号搜索，94 行候选映射）→ 9 项指标
  244 对比对（含 P0 历史版本变体行）→ 机械风险分级。脚本与阈值见
  [scan-manifest.json](scan-manifest.json)，方法与误报说明见 [README.md](README.md)。

## 结果数字

| 项 | 数值 |
|---|---|
| exact / normalized SHA-256 匹配 | **0** |
| high-text（raw ≥ 0.70） | **0** |
| high-structure（idnorm ≥ 0.55） | **0** |
| 独特注释命中（≥15 字符逐字相同） | **0** |
| 独特字面量命中（≥10 字符逐字相同） | 16 对次（触发 4 个文件） |
| 可比对中最高 raw | 0.1127（ports.ts ↔ backend-port.ts） |
| 全批最高 idnorm-5gram | 0.2152（index.ts ↔ index.ts，Electron API 样板敏感） |
| 最长公共块 | ≤ 6 行 |
| 机器风险 | high 4 / medium 0 / low 11 / blocked 0 |

high 的 4 个文件均为 distinctive-literal-match 机械触发（§10.3 规则）：
`electron/main/index.ts`（5 条：`before-quit`、`ready-to-show`、`second-instance`、
`unhandledRejection`、`window-all-closed` + 1 条模板字面量
``data:text/html;charset=utf-8,${encodeURIComponent(html)}``）、
`electron/main/ipc.ts`（2 条：`openDirectory`、`createDirectory`）、
`DesktopSetupWizard.tsx`（1 条：`downloading`）、`RuntimeStatusCenter.tsx`
（2 条：Tailwind 工具类 `flex items-center gap-2`、`space-y-1.5`）。
逐条内容见 `evidence/voicestudio/excerpts/`。

## 时间顺序（仅 P0，机器可表述部分）

41 个 P0 候选历史检查全部为 **voicestudio-first**（VS 候选首次引入早于 Semovix
对应文件首次引入；Semovix 15 文件均为 2026-09-28/29 单一作者首次引入，无更早
`--follow` 历史）。历史变体比对（VS 首版 / Semovix 引入前最近版 / 当前版 /
Semovix 首版）中仅 3 组出现任何信号，均为上述 API 常量字面量命中；**无任何
候选对在历史版本上出现高于当前版的相似峰值**。

## 需人工特别注意（机器观察，非结论）

1. `server/lib/safeFs.ts`：与 `backend/core/path_security.py` 职责同构且
   `resolveWithin/UnsafePathError` 与 `resolve_within/UnsafePath` 命名层相似；
   该文件头注释已自述「自 VoiceStudio 吸收、独立实现」。跨语言指标无命中
   （raw 0.066），「吸收原则后独立实现」的成立需人工逐行对照
   （见 review-notes.md 对应节）。
2. `electron/main/index.ts` ↔ `blank-window-guard.ts`：模板字面量
   ``data:text/html;charset=utf-8,${encodeURIComponent(html)}`` 一行逐字相同
   （含变量名 `html`），需人工确认是否属通用写法。
3. `supervisors.ts` ↔ `backend.ts`：职责同构（本地子进程监管）但类结构、
   常量组合、状态机实现不同，idnorm 0.177，需人工对照确认。

## 已知局限

指标不覆盖：低于阈值的碎片相似、换名重写、概念/命名层吸收、npm/PyPI 依赖
片段与官方示例等其他第三方来源；identifier-normalized 对框架样板敏感（正向
数值不能直接当作复用证据）。详见 README.md「已知误报与漏报」。

## Blocked 项

无（对比仓库与范围文件全部可用；两仓库工作区在采集时均干净——审计产物除外）。

## 下一步

由人工审查人按 `manual-review.csv` 逐文件分类（词汇见 README §人工可选分类），
重点先看上节 3 项；双人复核完成前不做任何 LICENSE 决定。
