# coserops-x-translator

X / Twitter 时间线翻译工具，采用 Tampermonkey 用户脚本 + Cloudflare Workers 后端。

- [`x-timeline-translator/`](./x-timeline-translator/README.md)：用户脚本、安装说明和前端行为测试。
- [`x-translator-server/`](./x-translator-server/README.md)：基于 Hono + Chanfana + D1 的后端基础项目。
- [项目说明](./x-timeline-translator-项目说明.md)：功能范围及前后端分工。

当前前端已实现；后端尚未接入翻译服务或实现翻译接口，因此尚不能端到端完成真实翻译。前后端接口约定见用户脚本目录的 README。
