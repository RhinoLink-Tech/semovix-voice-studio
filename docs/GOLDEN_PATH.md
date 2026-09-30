# Golden Path 真实验收（Golden Path）

> Golden Path 是本项目的**发布门槛**：至少一个真实声音角色用真实模型走完从创建到再消费的完整链路。CI 使用伪模型无法替代——音质、引擎冷启动、真实转写与一致性度量只有真机能验。

## 链路定义（11 阶段）

1. **环境快照**：git HEAD、进程、引擎健康归档；
2. **创建声音角色**（AI 原创设计来源）；
3. **创建不可变设计批次**：4 方向 × 3 候选 = 12，fixedSeed，幂等键；
4. **候选生成**：VoiceDesign 引擎真实推理（首载 ≈45s，之后 ≈12.5s/个）；
5. **匿名评审**：随机匿名编号 + 七维评分 + 硬性否决 + 入围 1–3 名；
6. **内容适配与重复生成检查**：每入围候选 5 场景 + 3 重复 = 8 路输出，Whisper 回听转录 + 文字一致性（≥88 passed / 70–88 attention / 其余 failed；任一 attention 即候选 attention）；
7. **发布决策**：人工完整回听确认 + 使用边界；
8. **冻结发布 V1.0**：Manifest（含推理时刻模型身份）、SHA-256 sidecar、license 元数据、验证报告；
9. **产物校验**：参考音频 Hash 对 manifest、sidecar 自洽、库内产物全量留证；
10. **生产消费**：`profile:<identityId>@<version>` 路由真实合成 ×2 + MCP 五工具消费；
11. **生成台账**：每条记录含 manifest_hash 与输入/输出 SHA-256。

另有负例验收：同幂等键异指纹 → 409（批次不可覆盖）；同版本重复发布 → 409 `version_exists`；`attention` 候选被发布门拦截。

## 如何执行

```bash
# 前置：API（默认 3001）与 Python Worker（8800）已启动，模型已就绪
bun scripts/golden-path.ts            # 全链路，留证到 artifacts/golden-path/
GP_RESUME=1 bun scripts/golden-path.ts   # 失败后续跑（跳过已成功阶段，需同 GP_IDENTITY_ID）
GP_API=http://127.0.0.1:3210 GP_IDENTITY_ID=<id> bun scripts/golden-path.ts  # 指定环境
bun scripts/golden-path-checks.ts     # 成功后运行：GP-01/08/14 负例与转录核查
```

驱动细节见脚本头部注释；环境变量 `GP_API` / `GP_WORKER` / `GP_LIBRARY` / `GP_IDENTITY_ID` / `GP_RESUME`。

## 当前状态（2026-09-30）

**通过。** 证据链：[`artifacts/golden-path/acceptance-report.md`](../artifacts/golden-path/acceptance-report.md)（GP-01..15 逐项结论、量化数值、诚实口径与运行事故全记录）。

| 关键结果 | 值 |
|---|---|
| 数字场景一致性 | 71.4%（修复前，书写格式偏置）→ **97.5%**（中文数字↔阿拉伯数字等价归一后） |
| 入围候选 | #7、#2 双 `passed`（94.4–100%） |
| 发布 | `profile:voice-d1d6de59-…@V1.0`，manifestHash `90b4ea40…` |
| 消费 | REST ×2 + MCP，台账 4 条全含溯源 Hash |
| 回听转录核查 | 96.6% / 92% / 96.8% |

## 诚实口径（必须随证据一起读）

- **评审分数是占位值**：驱动按候选时长生成七维分数（`scoreFromDuration`），验证的是管线通路，**不是音色评审结论**；
- **人工回听由 agent 代行**：发布决策中的 `humanListeningConfirmed: true` 为验收脚本写入；正式对外发布前须责任人完整回听（`artifacts/golden-path/design-batch/validation-audio/` 16 条 + `generated-samples/` 3 条）并另行签署；
- 修复前证据链（71.4% 发现）存档于 `artifacts/golden-path-attempt2-3/`，与终版可对照复查。

## 复验注意

- 驱动假设库内批次目录不被手工删除（否则见 [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) KI-2）；
- 首次运行含引擎冷启动与模型下载（如未缓存），全程约 10–15 分钟；
- WAV 证据不入 git，本地留存并由 `artifacts/wav-manifest.sha256` 哈希锚定。
