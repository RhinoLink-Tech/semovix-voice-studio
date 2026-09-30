# Golden Path 真实验收报告（发布基线 PR-3 · §2.6）

> 状态：**阻塞于发布门（真实发现）**——全链路管线验证至「内容适配与重复生成检查」；两名入围候选均被判 `attention`，发布被系统如实拦截。GP-09..14（消费侧）因无已发布 Profile 无法执行。**结论与处置选项见 §4。**
>
> 运行标识：`20260930-102140` ｜ 驱动：`scripts/golden-path.ts`（+ 补充验证）

## 1. 验收环境

| 项 | 值 |
|---|---|
| 日期 | 2026-09-30 |
| 执行人 | Claude（agent 驱动；人工复听未做，见 §5） |
| 代码 | 分支 `v2026.09.25`，HEAD `cd2fc5a` |
| Node API | `http://127.0.0.1:3001`（tsx server.ts，进程始于 2026-09-30 13:56:42 +0800） |
| Python Worker | `http://127.0.0.1:8800`（protocolVersion 3，四引擎懒加载） |
| 机型 | Apple Silicon macOS（开发机） |
| 模型 | VoiceDesign / Base（HF 缓存 4.2G ×2，VoiceDesign 为本次验收前预下载）、CustomVoice（外置卷）、whisper-large-v3-turbo（1.5G） |

**服务器与 HEAD 等效性**：API 进程启动早于 HEAD 最后三个提交（6b9e275 文档 / a94caaf 版本对齐 / cd2fc5a 克隆门）。`git diff c5ebd8d..cd2fc5a -- server/` 仅涉 `voiceSourceLifecycle.ts` 与 `voiceProfileTts.ts` 的克隆发布/消费门，不在 AI 原创链路——本验收所经路由代码与 HEAD 逐字一致。

## 2. 全链路时间线（第三次运行，前两次见 §6）

| 阶段 | 起止（UTC） | 耗时 | 结果 |
|---|---|---|---|
| 0 环境快照 | 10:21:41 | 0.1s | git/进程/引擎状态归档 |
| 1 创建声音角色 | 10:21:41 | 0s | 复用 `voice-d1d6de59-…`（attempt1 创建） |
| 2 创建设计批次 | 10:21:41 | 0s | 批次 `20260930-02`（4 方向 × 3，fixedSeed=20260930） |
| 3 候选生成 | 10:21:41–10:24:41 | 180.1s | 12/12 完成（≈15s/个，引擎已热） |
| 4 匿名评审 | 10:24:41 | 0s | 入围 #12、#8；占位否决 #11（口径见 §5） |
| 5 内容检查 | 10:24:41–10:29:41 | 300.2s | 16/16 完成；**#12、#8 均 `attention`** |
| 6 发布决策 | — | — | **未执行**（无 `passed` 候选，服务端发布门将拒） |
| 7–11 发布/校验/消费/MCP/台账 | — | — | **阻塞**（依赖已发布 Profile） |

引擎加载（`logs/engine-states.jsonl` 状态迁移）：voice_design 首载 ≈45s（attempt1）；本次 voice_clone 冷→ready ≤20s、whisper_asr loading→ready 20s（权重页缓存热）。候选生成 15s/个；内容检查 18.8s/路（含推理 + Whisper 回听）。

## 3. 链路对象

| 对象 | 值 |
|---|---|
| 声音角色 | `voice-d1d6de59-632c-4674-9694-3ee2a93b68d9`（Semovix 官方讲解员（Golden Path），AI 原创设计，中文） |
| 设计批次 | `20260930-02`（manifest 不可变，幂等键 `gp-20260930-102140-design`） |
| 入围 / 结果 | #12 `attention`(1)、#8 `attention`(1) —— 无 `passed` |
| Voice Profile | **未发布**（被发布门拦截） |

## 4. 阻塞发现（P0 级，需 owner 决策）

**现象**：真实模型组合（Qwen3-TTS Base + whisper-large-v3-turbo）下，固定测试场景「数字与日期」的文字一致性稳定为 **71.4%**（阈值：≥88 `passed`，70–88 `attention`，`stabilityValidation.ts:55-58`）。任一 `attention` 即令候选整体 `attention`，而发布门要求 `passed`（`voiceLifecycle.ts:277`）。

**机制**：场景文本使用中文数字（「二零二六年九月二十四日…二十四小时…稳定复现」），TTS 朗读内容正确，Whisper 将其转写为阿拉伯数字（「2026年9月24日…24小时…稳定复线」）。字符级 Levenshtein 对数字书写格式不敏感的等价内容判罚，叠加 1 处同音字（复现→复线），得 71.4%。**语义正确、度量格式偏置。**

**系统性**：场景文本为 `TEST_SCENARIOS` 常量，与种子/候选无关——**任何 AI 原创候选都会命中此场景**。库内检索确认：此前从未有 AI 原创来源的已发布 Profile（唯一存量为 Provider 预置音色，2026-09-29 冻结）。即 AI 原创发布路径在真实模型下从未走通，本次是首次触底。

**影响**：AI 原创来源（README 主流程第一来源）在真实模型下无法发布任何 Voice Profile → §2.6 Golden Path 无法完成 → 按验收文档口径属 P0 未过。

**处置选项**：
- **A（工程修正，推荐）**：为 `textConsistency` 增加中文数字 ↔ 阿拉伯数字等价归一（「二零二六」≡「2026」、「二十四」≡「24」）。修正后本场景 ≈97%（仅剩同音字差异）→ `passed`。属自动检查算法变更，需 owner 批准、补单测、并重跑本证据链。
- **B**：下调一致性阈值或改写场景文本——前者全局放水，后者降低检查严格度，均不推荐。
- **C**：维持现状如实披露——但 §2.6 为 P0，实际等于推迟发布。

## 5. 诚实口径声明

1. **匿名评审分数为脚本占位值**：七维分数由驱动按候选时长规则生成（`scoreFromDuration`），**不是音色评审结论**；入围与否决同理。管线通路（评分结构、否决+备注、入围约束）得到真实验证，音质判断未做。
2. **人工回听未执行**：本轮未走到发布决策；即便走到，`humanListeningConfirmed` 也只是 agent 驱动占位，正式发布前需责任人完整回听并签署。
3. 本次阻塞不是脚本缺陷：两次前置失败（§6）是驱动脚本问题，本次是**产品检查语义与真实模型行为的真实碰撞**——正是 Golden Path 要发现的问题。

## 6. 运行事故记录（全部披露）

| 次 | 结果 | 原因 |
|---|---|---|
| attempt1 | 止于评审 404 | 驱动时间戳含冒号 → identityId 非法（脚本缺陷）；其 12 候选真实生成，日志在 `../golden-path-attempt1/` |
| attempt2 | 批次永远 queued | 我手工删除批次目录后，分配器回收同号 `20260930-01`，`submitJob` 对既有任务行静默回放（`runner.ts:119-120`）——**产品边界发现：库内目录手工删除会破坏批次号唯一性假设**，建议入 KNOWN_ISSUES |
| attempt3 | **有效运行**（本报告主体） | — |
| 附带 | 批次 `20260930-03` | 补测幂等键笔误（102141≠102140）意外创建，正常跑完，留存库中无害；`20260930-01` 为 attempt2 僵尸（永久 queued），无路由可见 |

## 7. GP-01..15 逐项结论

| 项 | 要求 | 结论 | 证据 |
|---|---|---|---|
| GP-01 | 设计批次创建后不可被覆盖修改 | **通过**：同幂等键+异指纹 → 409 `idempotency_key_conflict`，库内 batch.json 逐字节不变 | `logs/gp01-batch-immutability.json` |
| GP-02 | 候选匿名编号，评审不暴露偏置信息 | **通过**：评审视图仅匿名 id/时长/波形，无方向/种子 | `design-batch/review-candidates.json` |
| GP-03 | 七项分数、备注、否决、入围完整 | **通过（占位口径 §5.1）** | `design-batch/review.json` |
| GP-04 | 被硬性否决的候选不能入围 | **通过**：否决 #11 未入围；服务端校验拒收 | `design-batch/review.json` |
| GP-05 | 检查输出保存 WAV、Hash、时长、波形、转录 | **通过**：16 条证据含全字段 | `design-batch/validation-run.json` + `validation-audio/`（16 WAV） |
| GP-06 | 自动检查与人工回听 UI/文档明确区分 | **文档面通过**（README 主流程第 4 条、CAPABILITY_STATUS）；UI 面未逐页取证 | 文档引用 |
| GP-07 | 未通过自动检查或未回听，不能发布 | **通过（正面实证）**：`attention` 候选被发布门真实拦截 | `logs/timings.json` + `validation-run.json` |
| GP-08 | 发布目录不可覆盖已有相同版本 | 未执行（无已发布版本）；负例由集成测试覆盖 | `test/integration/voiceLifecycle*.test.ts` |
| GP-09 | Manifest 与参考音频 Hash 校验 | **阻塞** | — |
| GP-10 | 已发布 Profile 可被生产合成复用 | **阻塞** | — |
| GP-11 | 生成记录含 Profile ID/版本/Manifest Hash | **阻塞** | — |
| GP-12 | MCP 只能列出和使用已发布 Profile | **阻塞**（MCP 传输与工具面已由集成测试与 09-29 手动 E2E 覆盖） | — |
| GP-13 | 草稿/候选/损坏 Profile 不进可消费目录 | **阻塞**（负例由集成测试覆盖） | — |
| GP-14 | 两段新文案与 MCP 输出可播放、转录核查 | **阻塞** | — |
| GP-15 | 全部证据打包保存 | **部分**：本轮全部产物已归档于本目录 | §8 清单 |

## 8. 证据清单

```
artifacts/golden-path/
├── acceptance-report.md       # 本报告
├── role-snapshot.json         # 声音角色快照
├── role/                      # 库内角色目录（identity.json、audit.jsonl）
├── design-batch/
│   ├── batch.json             # 不可变批次快照（12 候选 seed/匿名编号/Hash）
│   ├── review-candidates.json # 匿名候选视图
│   ├── review.json            # 评审记录（占位口径 §5.1）
│   ├── validation-run.json    # 内容检查终态（16 条证据，含一致性数值）
│   ├── candidates/            # 12 个候选 WAV
│   └── validation-audio/      # 2 入围 ×（5 场景 + 3 重复）WAV
├── summary.json               # 驱动汇总（ids、失败点）
└── logs/
    ├── driver.log             # 全程日志（含三次运行）
    ├── api-calls.jsonl        # 每次请求的时延与状态
    ├── engine-states.jsonl    # 引擎状态迁移（冷启动耗时证据）
    ├── environment.json       # git HEAD / 进程 / 引擎健康快照
    ├── timings.json           # 阶段耗时
    └── gp01-batch-immutability.json
artifacts/golden-path-attempt1/  # 首跑现场（脚本事故，备查）
```

## 9. 遗留事项

1. **待 owner 决策**：§4 处置选项（A/B/C）。选 A 则：实现数字等价归一 + 单测 → 重跑本证据链 → GP-09..14 解锁。
2. 责任人复听 `design-batch/validation-audio/`（发布决策的前置，无论如何都需要）。
3. 库内残留：`20260930-01` 僵尸批次、`20260930-03` 冗余批次（§6）；建议产品后续提供批次清理/取消口径。
4. `submitJob` 对同 id 既有行静默回放（`runner.ts:119-120`）在库目录被手工删除后会挂起新批次——建议记入 KNOWN_ISSUES（PR-4）。
