# Semovix Voice Studio 桌面壳（Electron）

P0-A 桌面 Beta 的外壳实现。复用现有 React Renderer 与 Node/Python 服务，不引入第二套 UI。

## 目录

```
electron/
  shared/types.ts          # main/preload/renderer 三方共享的纯类型 + IPC 白名单契约
  main/
    index.ts               # 入口：单实例锁、孤儿收割、端口分配、窗口、退出清理
    smoke.ts               # --smoke 模式：无窗口跑完整启动链路并自检（P0-A #13）
    context.ts             # DesktopContext：装配 paths/logger/setup/supervisors
    ipc.ts                 # IPC 白名单处理器（P0-A #6）
    lib/
      appPaths.ts          # userData 目录治理（P0-A #7）
      condaResolver.ts     # conda 绝对路径解析（GUI 进程不继承 shell 函数/PATH）
      desktopConfig.ts     # config/desktop.json 原子读写
      doctorRunner.ts      # worker/doctor.py --json 的结构化运行（P0-A #8）
      logger.ts            # 统一日志：JSONL / 轮转 / 脱敏 / 最近错误（P0-A #11）
      orphanReaper.ts      # 残留进程收割（runtime.json PID + 命令行标记核对）
      ports.ts             # 动态端口分配与 HTTP 就绪等待（P0-A #5）
      runtimeStatus.ts     # 三类运行时状态聚合：进程 / 引擎 / 环境（P0-A #10）
      supervisors.ts       # Node / Python 子进程监管（P0-A #2/#3/#4）
      windowState.ts       # 窗口尺寸/位置持久化（P0-A #4：关闭前保存 UI 状态）
  preload/preload.ts       # contextBridge 白名单桥（无 Node 能力泄漏）
```

Renderer 侧组件在 `src/components/desktop/`（首次启动向导 + 运行时状态中心），经 `src/desktop/desktopBridge.ts` 探测桌面环境。

## 命令

| 命令 | 说明 |
| --- | --- |
| `bun run dev:desktop` | 编译壳并以开发模式启动桌面应用 |
| `bun run desktop:prod` | 先构建前端（生产包）再启动桌面应用 |
| `bun run build:electron` | 仅编译 main/preload（esbuild → electron/build/） |
| `bun run smoke:desktop` | 桌面冒烟测试（P0-A #13 验收） |

冒烟默认要求已配置 Python（与真实环境一致）；`SEMOVIX_SMOKE_SKIP_WORKER=1` 可显式跳过 Worker 检查（记录为跳过而非通过）。

## 关键设计

- **同源 API**：Renderer 加载 Node Express 的 `http://127.0.0.1:<动态端口>/`，`/api` 同源直连，Worker 只被 Node 访问。
- **Node 运行时**：打包后用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 拉起 server 子进程，不依赖系统 Node。
- **进程树终止**：POSIX 上子进程以独立进程组 spawn，停止时对整组发信号——`conda run` 之类包装进程不会留下内部 python 孤儿；`stop()` 以 `exit` 事件 + 绝对上限收尾，不受 stdio 管道被残留进程占住的影响。
- **模型配置语义**：空字符串 = 未配置 = 不注入环境变量，Worker 落回内置默认与项目 `.env`（不覆盖用户本地权重路径）。
- **本机开发注意**：若 shell 里设置了 `ELECTRON_RUN_AS_NODE=1`，启动脚本会自动剔除；单元测试通过注入 spawn/fetch/killTree 伪造子进程，不发真实信号。

## 数据目录（macOS：~/Library/Application Support/Semovix Voice Studio/）

```
config/   desktop.json（向导配置）
database/ library/  voice-profiles/   # 升级不触碰
temp/     # 每次退出清空内容
logs/     # main/node/worker/renderer.log（JSONL，5MB×3 轮转，14 天保留）
cache/
```

冒烟模式使用 `smoke-session/` 隔离的 userData，并继承真实会话的 `config/desktop.json`。
