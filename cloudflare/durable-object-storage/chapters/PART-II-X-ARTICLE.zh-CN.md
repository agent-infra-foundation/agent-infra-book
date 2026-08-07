# Cloudflare Computer：如何将 AI Agent 沙箱成本降低 80%

**Agent 需要一个持续存在的工作区，但不需要一台始终运行的 Linux 机器。**

## TL;DR

- **一个持久工作区：** Workspace Durable Object 及其 SQLite VFS 持有项目状态。
- **让常用路径保持轻量：** `workspace.fs` 和 `just-bash` 在 isolate 中处理读取、搜索、
  写入和小型编辑。
- **只在需要时启动 Linux：** `npm install`、`npm run build` 等原生操作进入按需
  container。
- **进程成功不等于持久化：** container 输出只有在命令后的 pull 完成后，才成为唯一
  事实源状态。
- **这是模型估算，不是固定折扣：** 把 container 活跃时间降到 10% 后，本文场景从
  **$36.83/月降至 $7.53/月，降幅为 79.6%**。

AI Agent 经常需要读取文件、搜索代码、修改配置，并在必要时运行 `npm install`
或构建命令。

传统方案通常为每个 Agent 准备一个完整 container。这样最容易理解，却也意味着：

> **即使 Agent 只是在读文件、思考或等待模型响应，我们仍可能在为 Linux 环境付费。**

[Cloudflare Computer](https://github.com/cloudflare/computer) 提出了另一种分工方式：

- 日常文件操作留在 isolate
- 项目状态保存在 Durable Object
- 只有原生工具真正需要 Linux 时，才启动 container

核心思想可以概括为一句话：

> **让状态一直存在，让完整操作系统按需出现。**

---

## 一个工作区，两种执行模式

<p align="center">
  <img src="../assets/part-ii/one-workspace-two-modes.png" alt="一个 Durable Workspace 同时连接 isolate 与按需 Linux container" width="40%" />
</p>

项目的唯一事实源，是 Workspace Durable Object 中的 SQLite VFS。

普通操作可以直接在 isolate 中完成：

- 使用 `workspace.fs` 读写文件
- 使用 `just-bash` 搜索文本和遍历目录
- 使用 JavaScript 转换数据
- 在等待 LLM 响应时不保留 container

当任务需要真实 Linux 能力时，再切换到 container：

- `npm install`
- `npm run build`
- 原生二进制程序
- 系统级依赖
- 需要真实操作系统的长期进程

这不是两个互不相关的工作区，而是：

> **一份作为唯一事实源的持久副本，加上一份按需创建的执行侧临时物化副本。**

container 启动后，Computer 把需要的文件 `push` 到 `computerd` VFS。Linux
程序通过 FUSE 看到普通的 `/workspace` 目录。

命令结束后，Computer 再把变更 `pull` 回 Workspace Durable Object。

**持久状态 → push → Linux 执行 → pull → 持久状态。**

---

## 用两种模式构建同一个网站

<p align="center">
  <img src="../assets/part-ii/build-website-two-modes.png" alt="网站依次在 isolate 中编写和检查、在 container 中构建、再回到 isolate 验证" width="40%" />
</p>

为了验证这套模型，我们使用 Cloudflare Computer 构建了一个 Vite 网站。

整个工作流只有四步：

1. 在 isolate 中编写源文件
2. 在 isolate 中检查项目
3. 在 Linux container 中安装依赖并构建
4. 回到 isolate 验证持久化产物

完整路径是：

> **isolate 编写 → isolate 检查 → container 构建 → isolate 验证**

只有原生构建阶段需要 Linux。

---

## 普通操作留在 isolate

第一个命令显式选择 `worker-shell`：

```ts
using inspection = await workspace.runtime.exec(
  "find . -type f | sort",
  {
    backend: "worker-shell",
    cwd: "/workspace/site",
  },
);
```

它看起来像 shell，但不是原生 Bash 进程。

`WorkerShellBackend` 在 Worker isolate 中运行 `just-bash`，并通过 RPC 直接访问
Workspace 文件系统。这里没有第二个文件系统，因此也不需要 push 或 pull。

读文件、搜索代码和小型编辑，都可以留在这条轻量路径上。

---

## 只有原生操作才升级到 container

安装依赖和 Vite 构建需要真正的 Node.js、npm 与 Linux，因此应用显式切换执行后端：

```ts
using build = await workspace.runtime.exec(
  "npm install && npm run build",
  {
    backend: "container",
    cwd: "/workspace/site",
  },
);
```

这里的关键不是命令长什么样，而是它需要什么 capability。

Computer 不会把所有 shell 语句都自动发送到 container。应用根据工具、生命周期和
安全边界选择执行后端。

完整的 backend 注册涉及 `Workspace`、`WorkspaceServiceProxy`、`WorkspaceProxy`
和 container WebSocket 路由。为了保证正文在手机上容易阅读，这部分保存在固定版本的
Git snapshot 中：

> [查看完整 Workspace 与双 backend 接线代码](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/src/index.ts)

---

## 命令成功，不等于已经持久化

这是 Cloudflare Computer 最容易被忽视的边界。

container 内的命令可能已经返回 `exitCode = 0`，但这只代表进程执行成功，不一定
代表输出已经写回 Durable Object。

应用还需要检查同步结果：

```ts
const result = await build.result();

if (result.exitCode !== 0 || result.sync.status !== "complete") {
  throw new Error("Build or synchronization failed");
}
```

只有命令后的 pull 成功提交到 Workspace SQLite，构建产物才真正跨过持久化边界。

因此，Computer 的成功条件有两个：

- 进程执行成功
- 工作区同步成功

如果命令成功而同步仍然是 `pending`，正确做法是重试或协调同步，而不是盲目重跑一个
可能不具备幂等性的命令。

---

## 为什么不把 `node_modules` 全部保存下来？

Computer 默认忽略 container 中的 `node_modules`。

一次 `npm install` 可能创建数万个小文件。它们对当前构建有用，却会显著增加同步
时间与持久存储占用。

更重要的是，`node_modules` 通常可以通过 `package-lock.json` 重建。

这让系统形成一个清晰边界：

- 源代码、配置、lockfile 和构建产物需要持久化
- `node_modules` 等执行缓存可以保持一次性

这不是丢失数据，而是主动区分**项目状态**和**可重建缓存**。

完整的 container 配置同样放在 Git snapshot 中：

> [查看固定版本 Dockerfile](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/Dockerfile)

---

## 80% 是怎么计算出来的？

这里的 80% 不是 Cloudflare 承诺的固定折扣，而是一个明确假设下的成本模型。

我们比较两个场景：

1. 一个 `standard-1` Cloudflare Container 每月持续活跃 720 小时
2. 同一个 container 只活跃 72 小时，也就是 10% 的时间

其余普通工作由 Workers、isolate 和一个 Workspace Durable Object 处理。

在本文采用的 CPU、内存、磁盘与套餐额度假设下：

- 始终活跃：约 **$36.83/月**
- 10% 活跃时间：约 **$7.53/月**
- 每月节省：约 **$29.30**
- 成本降幅：约 **79.6%**

完整账单不会恰好下降到 10%，因为每月 $5 的 Workers Paid 最低费用仍然存在。

最重要的变量，是 container 活跃时间占比：

- 活跃 5%：约 $6.09/月
- 活跃 10%：约 $7.53/月
- 活跃 25%：约 $12.41/月
- 活跃 50%：约 $20.55/月
- 活跃 100%：约 $36.83/月

所以，正确的问题不是：

> “Cloudflare Computer 是否一定能节省 80%？”

而是：

> **“我的工作流中，有多少操作真的需要 Linux？”**

[完整成本模型与计算过程](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/chapters/PART-II.zh-CN.md)
保存在书稿中，便于逐项核对。

---

## 哪些 Agent 最适合这种架构？

这套模式尤其适合：

- 大量读取、搜索和小型编辑
- 工具调用之间存在较长等待
- 偶尔安装依赖或执行构建
- `node_modules` 等缓存可以随时重建
- 源代码和最终产物需要持久保存
- Agent 工作负载具有明显的突发性

它不太适合：

- 每个操作都依赖原生二进制程序
- 必须持续运行开发服务器
- container 几乎无法休眠
- 工作区持续发生大规模修改
- 多个写入者同时修改同一个 Workspace

当 container 活跃时间逐渐接近 100% 时，双模式的成本优势也会逐渐消失。

---

## Cloudflare Computer 真正改变了什么？

Cloudflare Computer 没有消灭 container。

它改变的是 container 在系统中的角色：

> **container 不再是 Agent 一直居住的地方，而是需要 Linux 兼容性时才启动的工具。**

Durable Object 负责长期持有状态。

isolate 负责低成本的常用路径。

container 负责真正需要操作系统的兼容路径。

Computer 则负责在两者之间完成 push、执行和 pull。

最终的设计原则很简单：

> **只在操作确实需要完整操作系统时为它付费，而不是仅仅因为 Agent 拥有一个工作区。**

---

## 代码与复现

- [完整可运行项目](https://github.com/agent-infra-foundation/agent-infra-book/tree/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder)
- [完整 Worker 实现](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/src/index.ts)
- [Container Dockerfile](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/Dockerfile)
- [本地运行说明](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/README.md)
- [完整中文教程与成本计算](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/chapters/PART-II.zh-CN.md)

---

## 继续阅读 Agent Infra Book

本文来自开源项目 [Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book)。
这本系统工程书聚焦编码 Agent 背后的基础设施，包括沙箱、持久工作区与执行架构。
项目把架构分析、可运行实现和实测证据放在同一个仓库中。

- [Star 并关注 Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book)
- [阅读完整的 Cloudflare Durable Objects 专题](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/durable-object-storage)
- [运行双模式网站构建示例](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/durable-object-storage/examples/dual-mode-website-builder)

> **如果你正在构建编码 Agent、沙箱或持久工作区，欢迎阅读、复现并共同完善这个项目。**

Cloudflare Computer 仍是 preview 软件。API、限制、运行行为与计费都可能变化。在把
本文模型用于生产预算之前，请重新核对 Cloudflare 的最新文档与价格。
