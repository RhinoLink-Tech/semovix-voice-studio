# 关键文件来源审查（Critical File Review）

> 验收 LIC-02 证据：对 `safeFs.ts`、`supervisors.ts`、`managedRuntime.ts` 三个关键文件的逐文件来源结论。
>
> **审查方法**：机器比对（下方数据）+ 人工通读（本表"功能与结构描述"列）。比对基线：VoiceStudio 本地克隆 `debpalash/VoiceStudio`（HEAD `08a1592e`，AGPL-3.0）。比对日期：2026-09-30。
>
> **签署规则**（验收 §6）：代码作者不能是来源审查的唯一复核人。本表由审查执行人完成比对与初判，**最终采纳需复核人签字**（文末）。

## 比对方法与全库背景

- 全库三层自动化初筛（字节级 md5、同基名代码对行相似度、特征行全库检索）结论为**零复制证据**，记录见 [CODE_PROVENANCE.md](../../CODE_PROVENANCE.md)「自动化初筛记录」；
- 本文件对三个关键文件做**聚焦复核**：与 VoiceStudio 功能最近邻文件逐一计算行级相似度（difflib.SequenceMatcher，剔除空白与注释行后按序比对——比初筛的单行最长公共子串更严格，数值天然偏低，作方向性证据）。

## 逐文件结论

### 1. `server/lib/safeFs.ts`（86 行）

- **功能**：素材库路径边界公共工具——resolve 后包含关系校验（拒 `../` 逃逸）、realpath 校验（拒符号链接逃逸）、ZIP 解压条目数/大小限制与 safeArchivePath（拒 ZIP Slip）。配套 `atomicFiles.ts` 临时文件 + rename 原子写。
- **VoiceStudio 对照面**：VS 后端为 Python（`backend/`），无 Node 侧同名或同职责文件；其 Python 内的路径处理（`backend/core/config.py` 等）与本文件无接口对应关系。
- **比对结果**：与 VS `electron/src/main/backend.ts` 行级相似度 **0.2%**；与 `backend/core/config.py` **0.0%**。
- **结论**：**独立实现**。设计原则（路径必须限制在素材根内、防 Zip Slip）属通用安全实践；文件头已如实标注"自 VoiceStudio 吸收、独立实现"的设计参考关系。

### 2. `electron/main/lib/managedRuntime.ts`（422 行）

- **功能**：托管 Python 运行时（uv 路线）——定版 uv 二进制下载（SHA-256 校验后启用）、uv 管理的 CPython、venv + 精确锁文件同步、`state.json` 阶段状态机（absent → … → ready，原子写）、修复与重建。
- **VoiceStudio 对照面**：VS 的对应能力分散在 `electron/src/main/runtime-project.ts`（554 行）、`runtime-download.ts`（97 行）、`backend.ts`（1248 行）。
- **比对结果**：行级相似度分别 **0.9% / 7.8% / 1.5%**。最高项 7.8% 出自 `runtime-download.ts`，重合内容为「node:https 下载 + 逐块流式 + 哈希校验」的公共 Node 惯用法，双方各自实现。
- **结论**：**独立实现**。"用户无需自备 Python、桌面自管一套解释器"的产品设计吸收自 VS 的公开设计（文件头已标注）；状态机划分、uv 工具链选型细节、锁文件策略均为本仓库独立实现。

### 3. `electron/main/lib/supervisors.ts`（505 行）

- **功能**：子进程监管（NodeServerSupervisor / PythonWorkerSupervisor）——checking → starting → ready 状态机、受控自动重启（仅 Node）、主动退出与异常退出的区分、不向 Renderer 暴露子进程对象（只暴露 `{state, port, pid, detail}`）、stdout/stderr 统一日志、spawn/fetch 可注入以便测试。
- **VoiceStudio 对照面**：VS `electron/src/main/backend.ts`（1248 行，其后端进程编排）、`backend-port.ts`（47 行，端口处理）。
- **比对结果**：行级相似度分别 **2.2% / 2.5%**。
- **结论**：**独立实现**。差异点可直观核对：本仓库为双监管者（Node + Python Worker）显式状态机与测试注入设计；VS 为单 Python 后端的编排逻辑，结构与 API 面不同。

## 总结论

三个关键文件均为**独立实现，未识别到未处理的 VoiceStudio AGPL 代码引入**。设计层参考（托管运行时、进程监管职责划分）已在代码文件头与 [CODE_PROVENANCE.md](../../CODE_PROVENANCE.md) 如实声明，属"参考设计、独立实现"口径，不触发 AGPL 传染条件。LIC-02 通过（待复核人签字生效）。

## 复核签字

| 角色 | 姓名 | 结论 | 日期 | 备注 |
|---|---|---|---|---|
| 来源审查执行人（初判） | Claude（agent，机器比对 + 通读） | 三文件独立实现 | 2026-09-30 | 数据与描述如上 |
| 复核人（必须 ≠ 代码作者） | ____ | ____ | ____ | |

> 复核人请抽查：任选一个文件与对应 VS 文件并排通读，核对上表"功能与结构描述"是否属实、相似度量级是否合理。
