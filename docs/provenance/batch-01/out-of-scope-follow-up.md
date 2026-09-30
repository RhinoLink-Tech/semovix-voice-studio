# Batch 01 范围外但职责相关的后续建议

以下文件**不在 Batch 01 范围内**（未做指标比对、未做历史比对、无任何结论），
仅因与 Batch 01 文件职责相邻或被其 import 而列出，建议纳入后续批次：

## 桌面壳相邻（建议并入后续「Electron 壳补全」批次）

| 文件 | 职责 | 与 Batch 01 的关系 |
|---|---|---|
| `electron/main/lib/appPaths.ts` | userData/日志/库目录解析 | index.ts/context.ts 依赖；VS 有运行时位置发现等相邻职责（未验证） |
| `electron/main/lib/desktopConfig.ts` | 桌面配置（素材目录等）持久化与 schema | context.ts 的 loadSetup/applySetup 底层 |
| `electron/main/lib/logger.ts` | 主进程日志 | index.ts 初始化 |
| `electron/main/lib/windowState.ts` | 窗口位置/尺寸持久化 | index.ts 装配；VS 有窗口状态相邻实现（未验证） |
| `electron/main/lib/condaResolver.ts` | conda 环境发现与解析 | supervisors/doctorRunner 的解释器来源之一 |
| `electron/main/lib/updateCheck.ts` | 手动更新检查（Stable/Preview） | ipc.ts / RuntimeStatusCenter.tsx 消费 |
| `electron/main/lib/diagnosticsBundle.ts` | 诊断包打包导出 | ipc.ts 消费 |
| `electron/main/smoke.ts` | 桌面冒烟入口 | 与主进程装配逻辑同源演进 |
| `electron/shared/types.ts` | 主/preload 共享类型 | preload.ts 依赖 |
| `src/desktop/desktopBridge.ts` | preload 桥的类型化封装 | fileDialogs.ts / 组件消费 |
| `src/desktop/capabilities.ts` | 桌面/Web 能力检测 | DesktopGate.tsx 依赖 |

## 服务端公共库（建议并入后续「服务端基础库」批次）

`server/lib/` 下其余文件与本批 `safeFs.ts` 同层，但职责属服务域，未在本批比对：
`atomicFiles.ts`、`profilePackage.ts`、`profileManifest.ts`、`profileLicense.ts`、
`storageCleanup.ts`、`diskUsage.ts`、`retention.ts`、`audioTranscode.ts`、
`audioWatermark.ts`、`speechPipeline.ts`、`transcribePipeline.ts`、`agentVoice.ts`。

其中 `profilePackage.ts`（档案包导入/导出）与 `safeFs.ts` 的 `safeArchivePath`
共用 ZIP 边界概念，后续批次应把两者的 VS 候选（如 VS 的项目导入/导出与
media 管理）一并纳入。

## 其他

- `server/` 路由层、`worker/`（Python）、`src/` 其余组件与页面：属后续批次；
- 本批符号搜索中出现的职责弱相关 VS 文件（twilio 面板、各导出面板等）已作为
  噪音候选记录在 counterpart-map.csv，无需单独跟进。

以上均未采集证据、未做任何来源判断。
