# Release Sign-off — v0.1.0-alpha

> 依验收 §6：小团队允许一人承担多个角色，但**代码作者不能是来源审查的唯一复核人**；
> 项目所有者不能跳过安全与许可阻断项；所有签字必须绑定精确 commit 和构建 Hash。
> Agent（Claude）完成了本版的构建、测试与文档工作，因此 Technical Owner 之外的角色
> 必须由人签署；无人签署前本版保持 CONDITIONAL GO 候选，不对外正式发布。

Release: 0.1.0-alpha
Tag: v0.1.0-alpha.1
Commit: ____________（tag 指向的提交，签署时填写）
Build SHA-256: dist/server.mjs `7af9da1ef274e8b1d49f9bd7f2da2b18e1c9080ebd870c8231e0851cf0ec82e6`；其余见 build/checksums.txt
Date: 2026-09-30（证据生成）

## Checklist

- [x] Licensing gate passed（来源初筛 + 关键文件审查 + 模型许可在线核对；**复核人签字待补**）
- [x] Build and tests passed（lint / 392+39 / build / 双冒烟 / package:dir，见 release-baseline.md）
- [x] Desktop runtime passed（smoke:desktop 7 项全过）
- [x] Golden Path passed（11 阶段真实验收，GP-01..15）
- [x] API and MCP passed（消费 ×2 + MCP 工具链 + 台账核对）
- [x] Security gate passed（密钥/依赖扫描 + 人工复核底稿；SBOM/签名列 Alpha 缺口）
- [x] Documentation reviewed（§2.12 十六文档齐备，含 KNOWN_ISSUES/SECURITY/INSTALLATION）
- [x] Known issues published（KNOWN_ISSUES.md，KI-1..5）
- [ ] Rollback package available（Alpha 源码发布无安装包；tag 即回退点）

## 人工回听确认（Golden Path 诚实口径补签）

> 驱动脚本中的评审分数为占位值、`humanListeningConfirmed: true` 为 agent 驱动标记。
> 责任人须重听以下音频并签署（目录 `artifacts/golden-path/`，WAV 哈希锚定于 `artifacts/wav-manifest.sha256`）：

- [ ] design-batch/candidates/（12 候选）
- [ ] design-batch/validation-audio/（2 入围 × 8 输出 = 16 条）
- [ ] generated-samples/（产品端点 ×2 + MCP ×1）

回听人：____ 日期：____ 结论：____

## Decision

- [ ] GO
- [x] CONDITIONAL GO（建议：源码以 Alpha 口径发布，安装包分发待签名/SBOM 补齐）
- [ ] NO-GO

Conditions / unresolved items：
1. CRITICAL_FILE_REVIEW 复核签字（licensing/critical-file-review.md 文末）；
2. 上方人工回听签署；
3. 云端 Gemini 服务条款所有者确认；
4. 安装包分发前：代码签名/公证 + SBOM/自动化依赖扫描。

## 签字

| 角色 | 责任 | 签名 | 日期 |
|---|---|---|---|
| Project Owner | 版本范围、能力口径、最终 GO / NO-GO | ____ | ____ |
| Technical Owner | 构建、测试、架构、Golden Path | ____ | ____ |
| License / Provenance Reviewer | 代码来源、第三方通知、模型与资产边界（须 ≠ 代码作者独自复核） | ____ | ____ |
| Security Reviewer | Electron、文件系统、上传、API、密钥和日志 | ____ | ____ |
| Product Reviewer | 页面流程、文案、已知限制与用户可理解性 | ____ | ____ |
