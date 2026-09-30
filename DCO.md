# Developer Certificate of Origin（DCO 1.1）

本仓库要求每个提交附带 `Signed-off-by` 行，表示贡献者接受以下证书原文（Developer Certificate of Origin, Version 1.1，© Linux Foundation，原文照录）：

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
660 York Street, Suite 102,
San Francisco, CA 94110 USA

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## 本仓库的附加约束

DCO 只覆盖代码版权声明；以下内容**无论是否签署 DCO 都不接受提交**（详见 [CONTRIBUTING.md](CONTRIBUTING.md) 的贡献边界）：

- 模型权重与模型分发包；
- 他人录音、参考音频、Voice Profile、授权文件；
- 无权再分发的第三方代码（含 AGPL 项目实现——本项目仅参考其公开设计，贡献若源自此类项目必须在 PR 中声明来源）；
- 未经确认来源的字体、图标、商标图件。

## 如何签署

提交时使用 `-s`：

```bash
git commit -s -m "feat(...): ..."
# 生成：Signed-off-by: 你的名字 <你的邮箱>
```

补签历史提交：`git rebase --signoff <base>..HEAD`（需要 `user.name` / `user.email` 已正确配置，且与提交身份一致）。
