# Batch 01 Review Notes（机器观察素材，非结论）

> 数据来源：`similarity-results.csv`、`counterpart-map.csv`、`file-inventory.csv`、
> `evidence/`（commit 绑定见 scan-manifest.json）。
> 「机器观察」仅使用固定词汇；「人工结论」全部待人工确认。

---

## `electron/main/index.ts`（P0）

### 功能
Electron 主进程入口：单实例锁、userData/日志、残留进程清理、动态端口、装配 Supervisor 与 IPC、创建安全 BrowserWindow（contextIsolation/sandbox=true）、状态轮询推送、15s 兜底退出清理。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28，feat(desktop): absorb P0-A desktop beta capabilities in Electron shell）
- 主要演进：`2e9319a6`（worker 冷启动）、`c5ebd8d`（managed ensure）、`fb76cdf`（safeFs 关联改动），共 4 个提交
- 当前主要作者：jinguoxing（blame：87% 行来自首次引入提交，单一作者）

### VoiceStudio 候选
- `electron/src/main/index.ts@08a1592e`：同为 Electron 主进程入口（种子职责映射 + 同名）
- `electron/src/main/blank-window-guard.ts@08a1592e`：内置错误页/空窗口防护（符号搜索命中）
- 其余 5 个同名 `index.ts`（preload/renderer i18n/routes、shared i18n/store）：重点目录内同名噪音候选，职责不同

### 文本证据
- 原始文本相似度：与 main/index.ts 0.065（历史各版本 0.065–0.069）；与 blank-window-guard.ts 0.051–0.055
- Token 结构相似度：idnorm-5gram 与 main/index.ts 最高 0.215（全批最高值，仍低于 0.55 阈值）
- 独特字符串/注释命中：5 条字面量逐字命中，全部为 Electron/Node API 事件名：`before-quit`、`ready-to-show`、`second-instance`、`unhandledRejection`、`window-all-closed`；注释命中 0；另有 1 条模板字面量与 blank-window-guard.ts 逐字相同：``data:text/html;charset=utf-8,${encodeURIComponent(html)}``（内联 HTML data URL 的通用构造写法，双方同用变量名 `html`）
- 最长公共块：3 行

### 结构比较
- 模块职责：双方均为「单实例 → 窗口 → 生命周期清理」的主入口；VS 另含 i18n/更新器/崩溃日志接线，Semovix 另含 Supervisor 装配与端口分配
- 状态机：Semovix 的启动序列在 supervisors.ts 状态机内；VS 在 backend.ts 内（本文件不含）
- 数据结构：Semovix 有 runtime.json 运行记录（PID/marker/端口）；VS 用 runtime-location.json / runtime-preferences.json（不同字段与用途）
- 控制流：退出路径均为 before-quit + preventDefault + 异步清理；Semovix 加 15s 强退定时器，VS 经 beginOrderlyQuit/tearDownNativeResources
- 错误处理：双方都有「不加载陌生 URL」的处理——Semovix 内联 zh HTML 错误页（data URL），VS blank-window-guard 带 20 语言 fallback 文案，实现规模与内容不同
- 常量组合：窗口背景色同为 `#0a0a0a`；preload 路径、安全开关不同（VS `sandbox: false` + ESM preload，Semovix `sandbox: true`）
- API / IPC 合同：共享 Electron 生命周期事件名（API 常量），通道合同不同（Semovix `desktop:*`，VS `pro:/repair:/backend:` 等命名空间）

### 时间顺序
- VoiceStudio 对应实现首次出现：main/index.ts 与 blank-window-guard.ts 均 2026-09-14（`data:` 模板字面量所在的 blank-window-guard 首次出现亦为 2026-09-14）
- Semovix 对应实现首次出现：2026-09-28（`8276d67e`）
- 时间顺序：voicestudio-first（历史各版本比对无更高相似峰值；指标随版本仅 ±0.005 波动）

### 机器观察
- 存在通用框架样板（Electron 生命周期事件名、data URL 构造写法、`#0a0a0a`）；存在独特字面量命中但均为 API 常量级；需人工确认 `data:text/html;charset=utf-8,${encodeURIComponent(html)}` 一行逐字相同是否属于 Electron 通用写法

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `electron/main/ipc.ts`（P0）

### 功能
IPC 白名单注册：app-info、运行时状态、doctor、重启 Worker、托管运行时维护、choose-directory/choose-file/choose-and-read-file（受限读取）、save-file（大小上限+原子写）、reveal-in-folder（realpath 边界校验）、诊断包导出、更新检查、save-setup（schemaVersion 校验）。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 5 个提交，最近 2026-09-29（P1 #35 诊断包 / #40 更新检查）
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `electron/src/main/ipc.ts@08a1592e`：同名 + 同职责（IPC 注册中心，643 行 vs 206 行）
- `electron/src/main/save-filters.ts@08a1592e`：对话框文件过滤器辅助（10 行，职责片段）

### 文本证据
- 原始文本相似度：与 VS ipc.ts 0.073–0.080（历史各版本一致）
- Token 结构相似度：idnorm-5gram 最高 0.174
- 独特字符串/注释命中：2 条字面量逐字命中，均为 Electron dialog API 属性名：`openDirectory`、`createDirectory`；注释命中 0
- 最长公共块：3 行

### 结构比较
- 模块职责：双方均为 ipcMain.handle 集中注册；VS 另含 trusted-renderer 校验、媒体授权、数据迁移/卸载扫描等大量领域通道
- 状态机：无（双方均为无状态 handler）
- 数据结构：VS 用 CHANNELS 常量表 + 命名空间桥（pro/repair/permissions/updates/watch/backend）；Semovix 用内联字符串通道 `desktop:*` + 白名单桥
- 控制流：对话框 handler 均为 showOpenDialog/showSaveDialog → canceled 判断 → 返回；Semovix 的 choose-and-read-file 把读取放主进程（Renderer 不经手路径），VS save 类通道用 randomUUID 临时文件
- 错误处理：双方均显式 throw 中文/英文错误；reveal 边界（Semovix realpath 包含校验）在 VS 无直接对应通道
- 常量组合：Semovix MAX_SAVE/READ_BYTES = 512MB；VS 无同值常量
- API / IPC 合同：通道名集合几乎不相交（`desktop:*` vs 命名空间式），仅共享 Electron API 属性名

### 时间顺序
- VoiceStudio 对应实现首次出现：2026-09-14（ipc.ts）
- Semovix 对应实现首次出现：2026-09-28
- 时间顺序：voicestudio-first（历史比对无更高相似峰值）

### 机器观察
- 存在通用框架样板（ipcMain.handle/dialog 属性名）；存在独特字面量命中但均为 API 常量级；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `electron/main/lib/supervisors.ts`（P0）

### 功能
抽象 `ProcessSupervisor`（spawn detached 进程组 + 健康检查轮询 + checking→starting→ready/failed/stopping→stopped 状态机 + SIGTERM→宽限→SIGKILL 优雅停止 + 代次计数防竞争）+ `NodeServerSupervisor`（60s 窗口 3 次受控重启）+ `PythonWorkerSupervisor`（managed/bin/conda 解释器解析）+ runtime.json 运行记录。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 3 个提交（P1 #31 managed 注入、#32 revision 钉定）
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `electron/src/main/backend.ts@08a1592e`（1248 行）：后端子进程生命周期/健康/重启（种子职责映射）
- `electron/src/main/runtime-project.ts@08a1592e`（554 行）：运行时项目管理
- `scripts/dev-backend.mjs@08a1592e`（335 行）：开发态 uvicorn 拉起与有界退避重启

### 文本证据
- 原始文本相似度：0.049（backend.ts）、0.028（runtime-project.ts）、0.024（dev-backend.mjs）
- Token 结构相似度：idnorm-5gram 最高 0.177（backend.ts）
- 独特字符串/注释命中：0 / 0
- 最长公共块：5 行（backend.ts）

### 结构比较
- 模块职责：双方均监管「Electron 主进程拉起的本地 Python/后端服务进程」；VS backend.ts 为单一大对象/函数集（含 attach 替换、supervise 轮询、日志环、区域选择），Semovix 为抽象类 + 两个子类的层次结构
- 状态机：Semovix 显式五态字符串状态机；VS 用 BackendStatus + supervise misses 计数（SUPERVISE_MISSES=3）判定
- 数据结构：双方都有「Python 启动命令数组」——VS `UVICORN_ARGS = ['uvicorn', 'main:app', '--app-dir', 'backend', '--host', '127.0.0.1']`，Semovix `['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', …]`（模块名、参数形态不同）；VS 常量 DEFAULT_PORT=3900、轮询 500/2000ms、SIGKILL 2000ms，Semovix 3000/8800、宽限 8000ms、STOP_CAP 2500ms、重启窗口 60s/3 次（数值组合不同）
- 控制流：健康检查——VS READY_POLL_MS 轮询 + PROBE_TIMEOUT；Semovix waitForHttpOk + 响应身份校验（JSON service 标记）；终止——双方均 POSIX 进程组/Windows taskkill 思路（Semovix killTree 显式实现，VS backend.ts 内置）
- 错误处理：双方都区分「主动停止」与「异常退出」；Semovix Node 侧有受控重启上限，VS dev-backend.mjs 有有界退避（各自实现）
- 常量组合：无相同数值常量组合命中
- API / IPC 合同：Semovix 通过 onStatus 回调推送；VS 通过 StatusListener

### 时间顺序
- VoiceStudio 对应实现首次出现：backend.ts / runtime-project.ts 2026-09-14，dev-backend.mjs 2026-07-16
- Semovix 对应实现首次出现：2026-09-28
- 时间顺序：voicestudio-first（历史比对无更高相似峰值）

### 机器观察
- 存在通用框架样板（spawn/健康轮询/SIGTERM→SIGKILL 为进程监管通用做法）；未发现直接逐字复用信号；职责同构但类结构与常量组合不同，需人工对照确认（medium 级别关注）

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `electron/main/lib/managedRuntime.ts`（P0）

### 功能
托管 Python 运行时（uv 路线）：定版 uv 二进制下载（SHA256 校验）→ uv 管理 CPython 安装 → venv → uv pip sync；阶段状态机 absent→fetching-uv→installing-python→creating-venv→syncing-deps→ready/failed 落盘；repair（从 creating-venv 重跑）/ rebuild（清目录全流程）；镜像环境变量透传。

### Semovix Git 历史
- 首次引入：`0545af162bb4`（2026-09-29，P1 #31）；共 1 个提交
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `electron/src/main/backend-download.ts@08a1592e`：后端运行时下载与校验
- `electron/src/main/runtime-download.ts@08a1592e`：运行时下载
- `electron/src/main/setup-progress.ts@08a1592e`（149 行）：首启安装阶段进度状态

### 文本证据
- 原始文本相似度：0.038（setup-progress.ts，最高）、backend-download 0.031、runtime-download 0.028
- Token 结构相似度：idnorm-5gram 最高 0.114
- 独特字符串/注释命中：0 / 0
- 最长公共块：3 行

### 结构比较
- 模块职责：双方都解决「用户不自备环境，应用自管运行时下载」；VS 下载的是打包后端/运行时资产，Semovix 下载 uv + CPython + venv（uv 官方路线）
- 状态机：Semovix 六阶段显式状态文件 state.json（原子写）；VS setup-progress 为进度上报（阶段集合不同）
- 数据结构：Semovix UV_VERSION='0.12.20' + 三个平台资产 SHA256 表 + MANAGED_PYTHON_VERSION='3.12'；VS 无同值常量
- 控制流：Semovix ensure 幂等（ready 短路零 spawn）；VS 下载校验流程各阶段超时不同（17MB/70MB 量级 vs Semovix 5–15 分钟超时）
- 错误处理：双方失败态均可恢复重入；repair/rebuild 语义为 Semovix 特有
- 常量组合：无相同数值常量组合
- API / IPC 合同：Semovix 经 context 暴露 repair/rebuild IPC；VS 无对应通道

### 时间顺序
- VoiceStudio 对应实现首次出现：backend-download/setup-progress 2026-09-14，runtime-download 2026-09-20
- Semovix 对应实现首次出现：2026-09-29
- 时间顺序：voicestudio-first（历史比对无更高相似峰值）

### 机器观察
- 存在通用框架样板（下载-校验-安装的通用流程形态）；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `electron/preload/preload.ts`（P0）

### 功能
安全 Preload：contextBridge 暴露 17 个白名单动作 + 单一 `desktop:runtime-status-changed` 事件订阅（返回取消函数，不暴露 ipcRenderer 本体）。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 5 个提交（随 IPC 通道演进）
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `electron/src/preload/index.ts@08a1592e`（145 行）：contextBridge 安全桥（种子职责映射）
- `electron/src/main/ipc.ts@08a1592e`：通道合同对照（documentation_reference）

### 文本证据
- 原始文本相似度：0.057–0.061（历史各版本一致，Semovix 首版与当前版几乎无差异）
- Token 结构相似度：idnorm-5gram 最高 0.175（全批 P0 中第二高，仍低于阈值——两文件都是 contextBridge+ipcRenderer.invoke 固定句式）
- 独特字符串/注释命中：0 / 0
- 最长公共块：3 行

### 结构比较
- 模块职责：双方均为 preload 唯一桥（contextBridge.exposeInMainWorld + ipcRenderer.invoke 白名单）
- 状态机：无
- 数据结构：VS 桥为命名空间对象（pro/repair/permissions/updates/watch/app/backend）且暴露 `__APP_VERSION__`；Semovix 为扁平方法对象 `semovoixDesktop` + 类型化 CHANNELS 表；事件订阅——VS 通用 `subscribe<T>()` 工厂返回取消函数，Semovix 仅 onRuntimeStatusChanged 一个订阅（同样返回取消函数）——「订阅返回取消函数」为 Electron 官方推荐模式
- 控制流：双方均为逐方法 invoke 转发，无逻辑分支
- 错误处理：无（依赖 invoke 异常传播）
- 常量组合：无共享常量
- API / IPC 合同：通道名集合几乎不相交

### 时间顺序
- VoiceStudio 对应实现首次出现：2026-09-14（preload/index.ts）
- Semovix 对应实现首次出现：2026-09-28
- 时间顺序：voicestudio-first（历史比对无更高相似峰值）

### 机器观察
- 存在通用框架样板（contextBridge/ipcRenderer.invoke/订阅取消函数为 Electron 官方固定写法）；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `src/desktop/fileDialogs.ts`（P0）

### 功能
原生文件能力模式无关封装：桌面走桥（原生对话框 + 主进程读写字节，Renderer 不经手裸路径），Web 回退 input[type=file] 与浏览器下载；pickFile / saveBytes / saveFromUrl / triggerBrowserDownload。

### Semovix Git 历史
- 首次引入：`8233f23b2b`（2026-09-28，P0-A #12）；共 2 个提交
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `electron/src/main/ipc.ts@08a1592e`：原生文件对话框 IPC 处理（种子）
- `electron/src/main/save-filters.ts@08a1592e`：保存对话框过滤器（种子）
- 另 10 个符号搜索候选（twilio 面板、各导出面板、规格文档等）：Symbols 命中噪音（如 `triggerBrowserDownload`、`pickFile` 类词），职责关联弱，raw ≤ 0.071

### 文本证据
- 原始文本相似度：主候选 ipc.ts 0.066 / save-filters 0.023；噪音候选 ≤ 0.071（not-comparable/low-signal）
- Token 结构相似度：idnorm-5gram 最高 0.112
- 独特字符串/注释命中：0 / 0
- 最长公共块：3 行

### 结构比较
- 模块职责：Semovix 为「Renderer 侧模式无关封装」（桌面/浏览器双路径）；VS 的对话框逻辑在主进程 ipc.ts 内、Renderer 经桥调用，无对应的双模式回退模块
- 状态机：无
- 数据结构：PickFileOptions/SaveResult 为 Semovix 特有；VS SaveAudioRequest/SaveDataRequest 字段不同
- 控制流：浏览器回退（动态 input + focus 取消检测、anchor download）为标准 Web API 用法；VS 不需要（纯桌面应用）
- 错误处理：fetch 失败抛错（Semovix）
- 常量组合：无共享常量
- API / IPC 合同：消费 `desktop:choose-and-read-file` / `desktop:save-file`（Semovix 自有通道）

### 时间顺序
- VoiceStudio 对应实现首次出现：2026-09-14（ipc.ts / save-filters.ts）
- Semovix 对应实现首次出现：2026-09-28
- 时间顺序：voicestudio-first（历史比对无更高相似峰值）

### 机器观察
- 未发现直接逐字复用信号；双模式回退结构为 Semovix 特有形态；符号搜索噪音候选已标注

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `server/lib/safeFs.ts`（P0，重点）

### 功能
安全文件边界公共工具：`resolveWithin`（resolve 包含校验 + 对最深已存在祖先 realpath 复核，拒绝 `../` 与符号链接逃逸）、`safeArchivePath`（ZIP Slip 白名单：拒绝绝对路径/反斜杠/`..`/非白名单字符段）、`ARCHIVE_LIMITS` 解压限额。文件头注释自述「原则（自 VoiceStudio 吸收、独立实现）」。

### Semovix Git 历史
- 首次引入：`fb76cdf33add`（2026-09-29，P0-B #25，收拢散落在各 Route 的检查）；共 1 个提交
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `backend/core/path_security.py@08a1592e`（94 行，Python）：路径信任边界守卫（种子职责映射，跨语言）
- `electron/src/main/watch-folders.ts@08a1592e`：目录访问边界（职责相邻）
- 另 10 个符号搜索候选（backend 各 router/service）：`contained`、`candidate`、`includes` 等通用词命中噪音

### 文本证据
- 原始文本相似度：与 path_security.py 当前版 0.066、其历史首版 0.080（跨语言，not-comparable）
- Token 结构相似度：idnorm-5gram 0.012–0.015（跨语言不解释）
- 独特字符串/注释命中：0 / 0
- 最长公共块：1 行

### 结构比较
- 模块职责：双方均为「把路径包含校验收拢在文件系统边界的公共守卫」——职责与文件定位同构
- 状态机：无
- 数据结构：**命名层面相似**——Semovix `resolveWithin`/`UnsafePathError` vs VS `resolve_within`/`UnsafePath`（概念与命名一致，实现语言与细节不同）；VS 另有 `safe_filename`（Windows 保留名/控制字符/240 字节上限/双分隔符正则），Semovix 另有 `safeArchivePath`（ZIP Slip 白名单正则 `[A-Za-z0-9._-]+`）与解压限额常量——互补而不重叠的校验集
- 控制流：resolve→contains→（Semovix：逐级 realpath 回溯 / VS：分隔符拆分与逐段校验）——算法路径不同
- 错误处理：双方均抛专用错误类型；错误消息文本不同（中文 vs 英文）
- 常量组合：Semovix ARCHIVE_LIMITS（50MB/120MB/32 条/512KB）无 VS 对应
- API / IPC 合同：无（服务端公共工具）

### 时间顺序
- VoiceStudio 对应实现首次出现：path_security.py 2026-08-09
- Semovix 对应实现首次出现：2026-09-29
- 时间顺序：voicestudio-first；且 Semovix 文件头已声明「吸收原则、独立实现」（docs/001.md 的设计参考记录与之一致）

### 机器观察
- 存在需要人工解释的结构相似（职责同构 + `resolveWithin/UnsafePathError` 与 `resolve_within/UnsafePath` 命名层相似，与文件头声明的吸收关系一致）；文本与 token 指标无命中（跨语言）；「吸收设计原则后独立实现」的成立与否需人工逐行对照确认

### 人工结论
- 分类：待人工确认
- 审查人：待指派
- 第二复核人：待指派
- 状态：未开始

---

## `electron/main/context.ts`（P1）

### 功能
桌面运行时上下文：装配两个 Supervisor、桌面配置 loadSetup/applySetup（校验+原子落盘+按需重启）、Doctor 缓存、状态 3s 轮询聚合（内容变化才推）、托管运行时编排、shutdown 清理；不 import electron 以保可单测。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 4 个提交（P1 #31/#32/#40 演进）
- 当前主要作者：jinguoxing（单一作者）

### VoiceStudio 候选
- `electron/src/main/backend.ts@08a1592e`：运行时编排的部分职责（种子，弱映射）

### 文本证据
- 原始文本相似度：0.048；idnorm-5gram 0.144；独特命中 0/0；最长公共块 3 行

### 结构比较
- 模块职责：VS 无独立「上下文装配层」（其编排内联在 backend.ts/index.ts）；Semovix 的 DesktopContext 为可单测聚合层
- 状态机/数据结构/控制流：配置热更新按需重启、状态去重推送为 Semovix 特有设计；VS 用 hooks/状态订阅模式
- API / IPC 合同：经 ipc.ts 暴露；VS 不同

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）；VS 候选首次出现 2026-09-14，晚于关系不适用（Semovix 2026-09-28 引入，仍为 voicestudio-first）

### 机器观察
- 存在通用框架样板；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `electron/main/lib/doctorRunner.ts`（P1）

### 功能
Doctor 运行器：按 Python 配置（managed/bin/conda）组装命令、90s 超时强杀、从混杂 stdout 提取首个括号配平 JSON（忽略字符串内花括号）、规范化 DoctorReport；退出码 1 不影响可解析性。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 2 个提交（P1 #31 managed 路径）

### VoiceStudio 候选
- `electron/src/main/repair-agents.ts@08a1592e`：诊断/修复执行（种子，职责相邻，映射待人工确认）

### 文本证据
- 原始文本相似度：0.040；idnorm-5gram 0.159；独特命中 0/0；最长公共块 5 行

### 结构比较
- 模块职责：VS repair-agents 为「修复代理」执行框架（事件流），无「环境体检 doctor」对应模块（VS 仓库 electron/ 内未检出 doctor 概念）
- 数据结构：DoctorReport/DoctorCheck（Semovix 自有契约）；extractBalancedJson 手写解析器无 VS 对应
- 常量组合：DOCTOR_TIMEOUT_MS=90s 无 VS 对应
- API / IPC 合同：`desktop:run-doctor`（Semovix 自有）

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）

### 机器观察
- 未发现直接逐字复用信号；候选映射本身较弱（repair-agents 是否构成对应由人工判断）

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `electron/main/lib/ports.ts`（P1）

### 功能
动态端口分配：connect 探测（避免 SO_REUSEADDR 误报）+ bind 探测、习惯端口被占回退 OS 随机端口；waitForHttpOk 健康轮询（可选响应身份校验防端口冒充）。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 1 个提交

### VoiceStudio 候选
- `electron/src/main/backend-port.ts@08a1592e`（47 行）：后端端口分配（种子，同名职责）
- 另 11 个符号搜索候选（backend py：`deadline`/`validate` 等通用词噪音）

### 文本证据
- 与 backend-port.ts：raw 0.113、idnorm 0.140、独特命中 0/0、最长公共块 4 行；噪音候选 not-comparable

### 结构比较
- 模块职责：双方均为「启动时为本地服务找可用端口」
- 算法不同：VS `availableBackendPort` 确定性候选阶梯（preferred + offset×1000，最多 16 级，处理 Windows EACCES 保留端口，倾向让后续实例发现同一后端）；Semovix `allocatePort` connect+bind 双探测后回退 listen(0) 随机端口（倾向避免撞车）——设计目标相反
- 常量组合：VS 无超时常量同值；Semovix socket.setTimeout(600)
- API / IPC 合同：无

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）；VS 候选首次出现 2026-09-14（voicestudio-first）

### 机器观察
- 存在通用框架样板（node:net createServer 探测为通用做法）；未发现直接逐字复用信号；算法路线差异显著

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `electron/main/lib/orphanReaper.ts`（P1）

### 功能
残留进程识别与清理：runtime.json 记录的 PID 存活检查（kill(pid,0)，EPERM 视为存活）→ `ps -p <pid> -o command=` 命令行 marker 复核（绝不盲杀）→ SIGTERM。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 1 个提交

### VoiceStudio 候选
- `electron/src/shared/utils/backendCrash.ts@08a1592e`：后端崩溃残留处理（种子，职责相邻）
- `backend/worker/lifecycle.py@08a1592e`：worker 生命周期/孤儿处理（种子，跨语言）
- 另 10 个符号搜索候选（native-linux-libraries.mjs 等 build 脚本，raw 0.188 not-comparable 为噪音上限）

### 文本证据
- 主候选 raw ≤ 0.05；idnorm 0.101；独特命中 0/0；最长公共块 5 行

### 结构比较
- 模块职责：VS 无「跨会话残留进程 reap」对应模块（其崩溃处理为当次会话内的 crash-journal/sentinel 机制）
- 数据结构：RuntimeRecord{pids+marker+ports}（Semovix 自有）；marker 复核防 PID 复用为通用运维做法
- 控制流：ps/execFile + 超时 3s + SIGTERM；VS 无对应链路
- 常量组合：无共享

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）

### 机器观察
- 未发现直接逐字复用信号；最高 raw 对为 build 脚本噪音（not-comparable）

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `electron/main/lib/runtimeStatus.ts`（P1）

### 功能
运行时状态聚合：进程（Supervisor 状态机）/引擎（Node 聚合接口优先，Worker /health 兜底）/环境（Doctor 静态体检 + Worker 实时 checkpoint）三类分开上报。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 2 个提交（P1 #31 快照）

### VoiceStudio 候选
- `electron/src/main/setup-progress.ts@08a1592e`：首启/运行时进度状态（种子）
- `electron/src/renderer/src/components/app-shell/status-runtime.ts@08a1592e`：运行时状态聚合（renderer 侧，种子）

### 文本证据
- raw 0.085；idnorm 0.093；独特命中 0/0；最长公共块 3 行

### 结构比较
- 模块职责：VS status-runtime.ts 是 renderer 侧纯函数（由 hooks 数据解析 Sidebar 状态）；Semovix 是主进程 fetch 聚合器——层级与数据源不同
- 数据结构：RuntimeStatus{processes,engines,environment,doctor,recentErrors}（Semovix 自有）vs SidebarModelStatus/RuntimeHealth（VS）
- 常量组合：AbortSignal.timeout 3000/4000ms（Semovix）无 VS 同值
- API / IPC 合同：`desktop:get-runtime-status` + 事件推送（Semovix 自有）

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）

### 机器观察
- 存在通用框架样板（fetch 聚合状态为通用模式）；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `src/components/desktop/DesktopGate.tsx`（P1）

### 功能
桌面能力门控：preload 桥存在且未完成首配 → 全屏向导；已完成 → 运行时状态中心；Web 模式返回 null。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 2 个提交

### VoiceStudio 候选
- `electron/src/renderer/src/components/backend-gate.tsx@08a1592e`：后端未就绪门控 UI（种子）

### 文本证据
- raw 0.028；idnorm 0.055；独特命中 0/0；最长公共块 2 行

### 结构比较
- 模块职责：门控形态相似（gate 组件包裹children/分支渲染），但数据模型不同：Semovix 依据 `firstRunCompleted` 单布尔；VS 依据 useBackendStatus 状态机 + 崩溃详情/修复 dock/i18n/ shadcn UI 套件
- 控制流：Semovix useEffect+alive 标志拉取 appInfo；VS hooks 订阅
- UI 技栈：Semovix 原生 Tailwind 类，VS lucide-react + radix 组件

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）

### 机器观察
- 未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `src/components/desktop/DesktopSetupWizard.tsx`（P1）

### 功能
首次启动向导：欢迎→素材目录→Python→设备→模型→Doctor→Worker 八步；模型六态映射（前三态来自 Doctor、后三态来自 Worker 引擎状态）；配置保存经 save-setup。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 3 个提交（P1 #31/#32 演进）

### VoiceStudio 候选
- `electron/src/renderer/src/components/setup-gate.tsx@08a1592e`：首次启动引导门控（种子）
- `electron/src/shared/api/setup.ts@08a1592e`：首启配置 API（种子）
- 另 10 个符号搜索噪音候选（含 backend/api/routers/capture_ws.py——`downloading` 状态词命中）

### 文本证据
- 与 setup-gate/api-setup：raw ≤ 0.069、idnorm ≤ 0.114、独特命中 0/0
- 1 条字面量命中来自噪音候选 capture_ws.py：状态词 `downloading`（≥10 字符的常用状态名）

### 结构比较
- 模块职责：双方均为「首启引导」；VS setup-gate 以后端下载/安装进度为核心（gate 内嵌进度），Semovix 向导为多步表单 + Doctor 体检 + Worker 启动验证
- 数据结构：WIZARD_STEPS 常量表 + WizardModelState 六态（Semovix 自有）；VS SetupState 不同
- 控制流：Semovix 步进 + 每步校验；VS 下载进度驱动
- API / IPC 合同：`desktop:save-setup`/`desktop:run-doctor`（Semovix 自有）

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）

### 机器观察
- 存在通用框架样板（状态词 `downloading` 为常用词）；该字面量命中来自职责无关的噪音候选；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## `src/components/desktop/RuntimeStatusCenter.tsx`（P1）

### 功能
运行时状态中心：右下角常驻入口 + 面板三区（进程/引擎/环境）；动作：重新体检、重启 Worker、打开日志、复制最近错误、手动检查更新（Stable/Preview 通道）。

### Semovix Git 历史
- 首次引入：`8276d67e31ea`（2026-09-28）；共 4 个提交（P1 #40 更新检查）

### VoiceStudio 候选
- `electron/src/renderer/src/components/app-shell/status-bar.tsx@08a1592e`：状态栏（种子）
- `electron/src/renderer/src/components/app-shell/status-runtime.ts@08a1592e`：状态来源（种子）
- 另 10 个符号搜索噪音候选

### 文本证据
- 与 status-bar：raw 0.060、idnorm 0.162；2 条字面量命中为 Tailwind 工具类字符串：`flex items-center gap-2`、`space-y-1.5`；注释命中 0；最长公共块 4 行

### 结构比较
- 模块职责：VS status-bar 为顶/底部状态条（常驻、紧凑）；Semovix 为右下角可展开面板（三区 + 动作按钮）——形态与交互不同
- 数据结构：消费 RuntimeStatus（Semovix 主进程聚合）vs SidebarModelStatus（VS hooks）
- UI 技栈：同为 Tailwind（工具类字符串命中由此而来）；VS 另用 shadcn/i18n
- API / IPC 合同：`desktop:*` 动作（Semovix 自有）

### 时间顺序
- 未按 §9 做历史版本比对（P1 文件）

### 机器观察
- 存在通用框架样板（Tailwind 工具类字符串为框架固定 token）；未发现直接逐字复用信号

### 人工结论
- 分类：待人工确认 / 审查人：待指派 / 第二复核人：待指派 / 状态：未开始

---

## 汇总口径备注

- 全部 15 个文件均为单一 Git 作者（jinguoxing）、2026-09-28/29 首次引入（P0-A/P0-B/P1 #31 系列提交），无更早历史（`--follow` 无改名前身）；
- 全部 P0 候选的 VoiceStudio 首次出现时间均早于 Semovix 对应文件首次引入（voicestudio-first），历史各版本比对均未出现高于当前版本的相似峰值；
- 指标最高值全批：raw 0.113（可比对）/ idnorm-5gram 0.215（index↔index，Electron API 样板敏感指标）/ 最长公共块 5 行 / 独特注释命中 0；
- exact hash 匹配 0；high-text / high-structure 触发 0。
