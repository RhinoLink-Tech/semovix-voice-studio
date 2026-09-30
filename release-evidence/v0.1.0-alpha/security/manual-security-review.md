# v0.1.0-alpha 人工安全复核记录

> 复核人：Claude（agent，依 SECURITY.md 威胁模型逐项核对）｜日期：2026-09-30 ｜基线：90b73ed + PR-4 文档/修复批次
> 正式发布前需安全责任人签字（见 ../sign-off.md §安全），本记录为技术核对底稿。

## 核对项

| 项 | 结论 | 依据 |
|---|---|---|
| 服务绑定面 | 仅回环：Node 默认 `127.0.0.1`（dev 3000/3210、桌面动态端口）、Worker `127.0.0.1:8800`（桌面动态端口）、Vite `--host 127.0.0.1` | package.json scripts、supervisors.ts buildCommand |
| 认证 | 无内置认证（单机定位，如实声明而非伪装） | SECURITY.md、README「安全与授权提示」 |
| 密钥处理 | 仅 `GEMINI_API_KEY` 一个外部密钥，.env 本地读取、logger 脱敏、.gitignore 排除；密钥扫描零真实值命中（secret-scan.txt） | context.ts、logger.ts、security/secret-scan.txt |
| 文件系统边界 | 素材路径 resolve 包含校验 + realpath 防 symlink 逃逸 + ZIP Slip 防护（safeFs.ts，独立实现见 CRITICAL_FILE_REVIEW） | server/lib/safeFs.ts |
| 上传面 | multer 内存/磁盘限制 + jszip 解压条目数/大小限制 + MIME 白名单（验收 §2.x 已覆盖测试） | server 路由测试（392 用例） |
| 进程边界 | Electron 主进程不向 Renderer 暴露子进程对象；Renderer 经 preload 白名单 IPC | supervisors.ts、preload |
| 数据驻留 | 素材/授权/台账全部本地（SEMOVIX_LIBRARY_DIR）；遥测默认关闭且未实现 | README「本地与云端边界」 |
| 遥测 | 无（a94caaf 已在文档声明） | README、SECURITY.md |

## Alpha 已知缺口（如实，未修复）

1. **未签名/未公证**：安装包无 Developer ID 签名与公证（release.mjs 如实标注 unsigned）；
2. **无 SBOM / 自动化漏洞扫描**：本目录 dependency-scan.txt 为人工盘点，正式发布前补 osv-scanner 或等价工具；
3. **授权克隆运行时策略检查未实现**：Alpha 已以 409 硬禁用该来源 Profile 的发布与生产调用（cd2fc5a）；
4. **多用户/公网部署不在范围**：需基础设施补 TLS + 认证（docs/DELIVERY.md）。

## 结论

与 SECURITY.md 声明的单机威胁模型一致，未见声明外的暴露面。缺口已如实登记，不阻塞 Alpha 源码发布，阻塞正式安装包分发的是第 1、2 项。
