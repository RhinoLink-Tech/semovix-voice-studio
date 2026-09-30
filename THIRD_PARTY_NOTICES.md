# 第三方声明（Third-Party Notices）

> **状态：审查未开始。本文件当前只是待填写模板：以下清单是依赖**名称**的事实记录（来自 `package.json` 与 `worker/requirements-*.txt` 的存在性），各条目的许可证、版权声明与分发义务均**待确认**，不构成任何结论。**

填写规则：

- 逐条核对许可证（以依赖发布包内 `LICENSE` / registry 元数据为准），登记许可证名与版权行；
- 需要随产物分发声明或源码义务（如 LGPL 类）的依赖单独标注；
- 模型权重、字体、图标等资产同样入册；
- 不确定就写"待确认"，不要猜。

## npm 依赖（package.json）

### 运行时依赖

| 包 | 用途 | 许可证 | 版权声明要求 | 备注 |
|---|---|---|---|---|
| @google/genai | Gemini 云端 TTS / 转录客户端 | 待确认 | 待确认 | |
| @modelcontextprotocol/sdk | MCP 服务 | 待确认 | 待确认 | |
| @tailwindcss/vite | 样式构建 | 待确认 | 待确认 | |
| @vitejs/plugin-react | 前端构建 | 待确认 | 待确认 | |
| better-sqlite3 | 本地元数据库 | 待确认 | 待确认 | |
| dotenv | 环境变量 | 待确认 | 待确认 | |
| express | HTTP 服务 | 待确认 | 待确认 | |
| jszip | Voice Profile 导入包解析 | 待确认 | 待确认 | |
| lucide-react | 图标 | 待确认 | 待确认 | |
| motion | 动画 | 待确认 | 待确认 | |
| multer | 文件上传 | 待确认 | 待确认 | |
| react / react-dom | UI 框架 | 待确认 | 待确认 | |
| undici | 推理长超时 HTTP 通道 | 待确认 | 待确认 | |
| vite | 构建工具 | 待确认 | 待确认 | |
| zod | 请求校验 | 待确认 | 待确认 | |

### 开发依赖

| 包 | 用途 | 许可证 | 版权声明要求 |
|---|---|---|---|
| electron | 桌面壳 | 待确认 | 待确认 |
| electron-builder | 安装包打包 | 待确认 | 待确认 |
| esbuild | 服务端打包 | 待确认 | 待确认 |
| typescript / tsx / vitest / supertest / @types/* | 类型、运行与测试 | 待确认 | 待确认 |
| tailwindcss / autoprefixer | 样式 | 待确认 | 待确认 |

## Python 依赖（worker/）

依赖清单文件：`worker/requirements-base.txt`、`worker/requirements-macos.txt`、`worker/requirements-cuda.txt` 及对应 lock 文件。

| 包 | 用途 | 许可证 | 版权声明要求 |
|---|---|---|---|
| 逐项登记（以 requirements 文件为准） | TTS / ASR / FastAPI 服务 | 待确认 | 待确认 |

## 模型权重

模型权重的许可与代码许可分开说明，见 [docs/MODEL_AND_LICENSE_MATRIX.md](docs/MODEL_AND_LICENSE_MATRIX.md)。本项目仓库不分发权重，权重由使用方首次运行时自行下载。

## 其他资产

| 资产 | 来源 | 许可证 | 备注 |
|---|---|---|---|
| 待登记（字体 / 图标 / 示例音频等） | 待填 | 待确认 | |
