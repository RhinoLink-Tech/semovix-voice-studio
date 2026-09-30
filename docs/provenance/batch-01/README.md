# Batch 01 证据包｜Electron 壳、运行时监管与原生文件桥 来源审查

围绕问题的自动化证据采集：Semovix Voice Studio 的 Electron 桌面壳、Node/Python
运行时监管、Preload/IPC、首次启动与运行时状态、原生文件桥接和安全路径处理，
是否存在来自 `debpalash/VoiceStudio` 的具体代码表达复用。

本证据包严格区分三层，任何人不得混用：

1. **自动化证据**：Hash、Git 历史、文本/Token 指标、候选对应关系（本包全部 CSV/JSON/TXT）；
2. **机器观察**：基于证据、限定检测方法的谨慎提示（固定词汇，见下）；
3. **人工结论**：`manual-review.csv` 中全部人工字段保持「待人工确认 / 待指派 / 未开始」，
   必须由人工审查责任人填写，代码模型不得代填。

## 审查基线

| 仓库 | commit | 工作区 | 说明 |
|---|---|---|---|
| Semovix（subject） | `c5ebd8d220046afd52df34e3ec4982f3fae887b3`（分支 audit/code-provenance-batch-01，基点） | 干净（审计产物除外） | 证据绑定精确 commit |
| VoiceStudio（comparison） | `08a1592e3cb9b4c36beef5fa3185ec2313bb1fea`（main） | 干净 | 完整本地历史（3381 commits，非浅克隆）；根 LICENSE 实测 AGPL-3.0 全文（SHA-256 见 evidence/voicestudio/repo-meta.txt） |

精确基线、阈值与脚本哈希见 [scan-manifest.json](scan-manifest.json)。

## 文件说明

| 文件 | 内容 |
|---|---|
| `scope.txt` | 范围展开结果（路径 \| 优先级 \| 存在性），`src/components/desktop/**` 已逐文件展开 |
| `file-inventory.csv` | 每文件语言、行数、字节、原始/规范化 SHA-256、首次引入提交（--diff-filter=A --follow 与 --follow 两个口径分列）、最近提交、提交数、审查优先级 |
| `file-history.csv` | 每文件关键历史节点（提交 >20 个时保留首次+变更量 Top8+最近，规则见行内与本文） |
| `counterpart-map.csv` | VoiceStudio 职责候选映射（种子职责映射 + 重点目录同名 + 特征符号固定字符串搜索） |
| `similarity-results.csv` | 自动化相似度指标与 risk_flag（含 P0 历史版本比对行，machine_notes 以 `history-variant:` 标注） |
| `manual-review.csv` | 人工审查表：机器可填列已填，全部人工结论列保持待确认 |
| `review-notes.md` | 逐文件机器观察与结构比较素材 |
| `summary.md` | 本批摘要 |
| `out-of-scope-follow-up.md` | 范围外但职责相关的后续建议 |
| `evidence/semovix/` | P0 文件的首次引入/历史摘要/blame 聚合证据 |
| `evidence/voicestudio/` | 对比仓库元数据、候选文件历史（仅元数据）、相似命中短摘录（≤20 行） |
| `evidence/machine-summary.json` | 机器汇总数据（供 review-notes/summary 生成引用） |
| `scan-manifest.local.json` | **含本机绝对路径，已加入 .gitignore，不得提交** |

## 指标方法

三种视图：

- **Raw**：原始字节/原始行；
- **Normalized**：UTF-8、去 BOM、LF、行内空白（含缩进）压缩为单空格；
- **Identifier-normalized**：注释单独提取（不删除，另行比对）；字符串→`<STR>`、
  数字→`<NUM>`、非关键字/非固定 API 名的标识符→`<ID>`；语言关键字、运算符与
  固定 API 名（ipcMain、contextBridge、spawn、process 等固定清单）保留。

九项指标：exact/normalized SHA-256 匹配、raw 行序列比（SequenceMatcher）、
规范化行多重集比（Dice）、Token 5-gram Jaccard、标识符归一 5-gram Jaccard、
最长公共连续块行数、独特字面量命中（≥10 字符字符串逐字相同）、独特注释命中
（≥15 字符注释逐字相同）。

阈值与排序：

- raw ≥ 0.70 → `high-text-similarity`；idnorm-5gram ≥ 0.55 → `high-structure-similarity`；
  独特字面量/注释命中 → 对应 distinctive flag；Hash 相同 → `exact-match`；
- 排序：risk 严重度降序 → idnorm 降序 → raw 降序 → 路径升序（稳定）。

## 已知误报与漏报（必读）

- **identifier-normalized 视图对框架样板天然敏感**：Electron 初始化、contextBridge、
  ipcMain.handle 等官方 API 固定写法会抬高结构相似度，本包数值仍低（最高 0.215），
  但该指标的正向数值不能直接当作复用证据；
- **独特字面量命中包含 API 常量**：Electron 事件名（`before-quit`、`ready-to-show`）、
  对话框属性（`openDirectory`）、Tailwind 工具类（`flex items-center gap-2`）等
  框架固定字符串也会触发 distinctive flag，逐条内容见 `evidence/voicestudio/excerpts/`；
- **跨语言对标记 `not-comparable`**：TS ↔ Python 的结构指标不做同语言解释；
- **漏报**：低于阈值的碎片相似、换名重写、概念/命名层面的吸收（如方法名与错误类型
  命名相似）不被本指标覆盖，需人工对照（safeFs.ts 一节有实例）；
- 仅覆盖 VoiceStudio 一个来源，未覆盖 npm/PyPI 依赖片段、官方示例等其他第三方来源；
- 历史版本比对按 §9 仅对 P0 文件的候选执行（首次引入版 / Semovix 首次引入前最近版 / 当前版）。

## 机器风险等级规则（mechanical）

- `high`：任一候选对触发 exact / distinctive / high-text；
- `medium`：idnorm ≥ 0.25 或 raw ≥ 0.25 或最长公共块 ≥ 10 行；
- `low`：有候选但所有指标低于上述提示线，或无候选；
- `blocked`：对比仓库/文件缺失无法检查。

## 人工可选分类（代码模型不得代选）

```text
内部独立实现
内部 AI 辅助实现，未识别到特定第三方来源
通用框架或配置样板
官方文档 / 官方示例改编
第三方原样引入
第三方修改引入
生成文件
自有静态资产
第三方静态资产
来源尚未确认
```

## 机器观察固定词汇

```text
未发现直接逐字复用信号 / 存在通用框架样板 / 存在需要人工解释的结构相似 /
存在高风险匹配 / 证据不足
```

机器观察永远不是结论；指标未过阈值不等于独立实现。

## 复现方式

```bash
bash scripts/provenance/collect-provenance-evidence.sh          # 采集（对比仓库只读）
python3 scripts/provenance/validate_batch01.py --output docs/provenance/batch-01 \
  --subject-root . --comparison-root "$VOICESTUDIO_REPO_ROOT"   # 校验
```

两次连跑输出除时间戳外逐字节一致（已验证）。对比仓库路径经 `VOICESTUDIO_REPO_ROOT`
或包装器内候选位置解析，公开产物不含本机绝对路径。
