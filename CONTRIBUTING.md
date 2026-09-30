# 贡献指南（Contributing）

感谢你考虑为 Semovix Voice Studio 贡献。Alpha 期仓库以稳定交付发布基线为主，请先读 [README](README.md) 的能力口径与 [CAPABILITY_STATUS.md](docs/CAPABILITY_STATUS.md)——**本仓库不接受宣传超出该矩阵的改动**。

## 开发环境

安装与运行见 [docs/INSTALLATION.md](docs/INSTALLATION.md)。

## 提交前必须通过

```bash
bun run lint                                   # TypeScript 无类型错误
bun run test                                   # vitest 392 项（伪模型，unit + integration）
python3 -m pytest worker/tests -q              # Worker 测试
bun run build                                  # Web + Node 生产构建
```

注意：跑全量集成测试前建议停掉本机真实 Worker（`:8800`），避免已知 flake（KI-3）。**不得**以 `passWithNoTests`、删断言、屏蔽异常的方式让失败消失（QA-10）。

## 代码约定

- 与周边代码保持一致的命名、注释密度与中文文档口径；
- 领域数据落 `library/` 的原子写 JSON（事实源），运行时索引才进 SQLite——见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的关键设计决策；
- 涉及用户可见能力表述的改动，必须同步更新 `docs/CAPABILITY_STATUS.md`，状态不得超出验收证据；
- 涉及一致性/许可/安全语义的改动需要对应单测。

## 贡献边界（许可硬约束）

1. **只提交你有权再分发的内容**。禁止提交：
   - 无权再分发的代码（含来自 AGPL/闭源项目的实现）；
   - 模型权重或任何模型衍生分发包；
   - 他人录音、参考音频、Voice Profile、授权文件；
   - 未经确认来源的字体、图标、商标图件（资产口径见 [ASSET_LICENSES.md](ASSET_LICENSES.md) 与 [TRADEMARKS.md](TRADEMARKS.md)）。
2. 本项目在能力与架构层面参考过 AGPL-3.0 项目的公开设计——贡献若源自此类项目，**必须**在 PR 中声明来源以便审查（[CODE_PROVENANCE.md](CODE_PROVENANCE.md) 口径）。

## 签署贡献（DCO）

本仓库采用 **Developer Certificate of Origin, DCO 1.1**：每个提交必须带 `Signed-off-by`（见 [DCO.md](DCO.md)）。提交时加 `-s` 即可：

```bash
git commit -s -m "feat(...): ..."
```

## PR 流程

1. Fork / 建分支，保持提交历史干净；
2. 通过上述全部检查并在 PR 中粘贴结果；
3. 描述"改了什么、为什么、验收证据"（涉及声音链路的附上真实模型验证方式）；
4. 首次贡献者随 PR 附上已完成的 DCO 签署。

## 行为与保密

- 讨论中不粘贴密钥、授权材料、真人音频；
- 安全问题走 [SECURITY.md](SECURITY.md) 的私密渠道，不开公开 issue。
