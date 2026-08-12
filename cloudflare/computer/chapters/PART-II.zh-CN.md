# 第二部分：Cloudflare Computer——如何将 AI Agent 沙箱成本降低 80%

Part I 在第 4 章完成了持久文件系统与执行成本的测量。Part II 从**第 5
章**继续，讨论 Agent 的工作应该在哪里运行。

Agent 在整个任务期间都需要自己的工作区，但并非每一步都需要一台完整的
Linux 机器。

> <u>**部署原则：**</u>
> **让持久状态始终可用；只在需要时启用原生 Linux 执行。**

[Cloudflare Computer](https://github.com/cloudflare/computer) 让 isolate-first
（隔离执行优先）的部署策略成为可能：把项目状态保存在 Workspace Durable
Object 中，在 isolate（隔离执行环境）里完成日常工作，只为原生命令启动 Linux。

本文会沿着两条路径构建一个小型 Vite 网站，然后比较两种成本模型：一种让
Cloudflare container 整月持续运行，另一种只让 container 在当月 10% 的时间里
处于活跃状态。在本文明确列出的假设下，月度估算从 **$36.83 降至 $7.53，
降幅为 79.6%**。

这是一个可复算的场景，不是 Cloudflare 承诺的折扣。实际结果取决于 container
活跃时间占比、实例规格、存储、请求量、CPU 用量和同步行为。

## TL;DR

- <u>**唯一事实源：**</u> Durable Object SQLite 在 isolate 与 container 的生命周期之外
  持有项目状态。
- **常用路径：** `workspace.fs`、`just-bash` 和 isolate JavaScript 负责普通的读取、
  搜索、写入与编辑。
- **兼容路径：** Linux container 运行真正的 `npm`、原生二进制文件、需要保留的
  进程和构建工具。
- **物理布局：** 系统包含一份作为唯一事实源的数据，以及一份通过 FUSE 暴露的
  临时 `computerd` VFS；它们不是同一个共享物理挂载点。
- <u>**持久化边界：**</u> container 输出只有在命令结束后的 pull 提交到 Workspace
  之后，才成为唯一事实源状态。
- <u>**模型估算：**</u> 在本文假设下，container 只活跃 10% 的时间时，每月成本为
  **$7.53，而不是 $36.83，降幅为 79.6%**。

```text
authoritative Workspace Durable Object
    |
    |-- common work --> isolate / workspace.fs / just-bash
    |
    `-- native work --> push --> container + FUSE --> pull
```

本文会严格区分三类证据：

| 标签 | 它能证明什么 |
| --- | --- |
| **平台定价** | Cloudflare 当前公布的 Workers、Containers 和 Durable Objects 计费参数。 |
| **开源实现** | 在 Computer `0.1.1` 和提交 [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b) 中核实的执行后端路由与同步行为。 |
| **模型估算结果** | 根据明确的利用率假设计算出的 $36.83 和 $7.53；它们不是实际生产账单。 |

---

## 第 5 章：10% Container 策略

> <u>**经济边界：**</u>
> **Computer 可以减少 container 使用时间，但不能保证每种工作负载都获得固定比例的
> 成本降幅。**

<p align="center">
  <img src="../assets/part-ii/one-workspace-two-modes.png" alt="作为唯一事实源的 Durable Workspace 同时服务于负责读取、搜索与编辑的轻量 isolate，以及负责安装、构建与原生工具的按需 Linux container。" width="40%" />
</p>

*图 1：一个持久化 Workspace 同时支持轻量 isolate 路径和按需 Linux 兼容路径。
这是一张概念图；具体的 VFS 与同步边界将在下文定义。*

### 哪些工作确实需要 container？

container 是一个很实用的兼容边界。它为 Agent 提供普通的 Linux 文件系统、原生
可执行文件、包管理器、进程控制和网络工具。问题在于，不应该把每个操作都当成需要
整套操作系统环境。

| Agent 操作 | 需要完整 Linux 吗？ | Computer 路径 |
| --- | ---: | --- |
| 读取或写入源文件 | 否 | Durable Object 中的 `workspace.fs` |
| 搜索文本或列出目录树 | 否 | `worker-shell`（`just-bash`） |
| 使用 JavaScript 转换数据 | 否 | Worker isolate |
| 等待 LLM 响应 | 否 | 无需活跃的 container 工作 |
| 安装 npm 依赖 | 通常需要 | Container |
| 编译原生依赖 | 是 | Container |
| 运行未经修改的 Linux 二进制文件 | 是 | Container |
| 托管需要真实操作系统的进程 | 是 | Container |

[Cloudflare Containers 的计费方式](https://developers.cloudflare.com/containers/pricing/)
是对活跃 CPU 用量收费，而预配内存和磁盘则在 container 运行期间计费。Containers
可以自动休眠，因此已经积极配置 scale to zero（缩容至零）的应用，其基线成本会低于
一台始终在线的服务器。真正的经济问题因此是：

> **isolate 路径可以减少多少 container 运行时间？**

本文的可运行示例会明确展示每一步的执行位置，而不是让模型隐式决定。

### 一个 Workspace 如何支持两种模式？

第一部分解释了 Computer 如何把文件系统存入 Workspace Durable Object。到了这里，
这套持久文件系统成为两种执行模式的交汇点。

```text
                         AUTHORITATIVE STATE
                  +-----------------------------+
                  | Workspace Durable Object    |
                  | SQLite-backed VFS           |
                  +--------------+--------------+
                                 |
                  +--------------+--------------+
                  |                             |
           COMMON OPERATIONS             NATIVE OPERATIONS
                  |                             |
         +--------v--------+           +--------v---------+
         | Worker isolate  |           | Linux container  |
         |                 |           |                  |
         | workspace.fs    |           | npm install      |
         | just-bash       |           | npm run build    |
         | JavaScript      |           | native binaries  |
         +-----------------+           +--------+---------+
                                                |
                                      computerd VFS + FUSE
                                      temporary materialization
```

*架构图：普通操作直接访问作为唯一事实源的 VFS；原生程序使用一次性的执行侧 VFS，
并在命令前后与它同步。*

### 工作区到底有一份还是两份副本？

| 组件 | 文件系统视图 | 持久性 | 同步方式 |
| --- | --- | --- | --- |
| Workspace Durable Object | 作为唯一事实源的 SQLite VFS | 持久 | 唯一事实源 |
| `workspace.fs` | 作为唯一事实源的 VFS | 事务完成时持久 | 无 |
| `worker-shell` | 通过 Workers RPC 访问作为唯一事实源的 VFS | 持久 | `sync: "none"` |
| Container 命令 | 挂载到 `/workspace` 的本地 `computerd` VFS | 一次性 | 执行前 push；执行后 pull |

因此，isolate 和 container **并不共享同一个物理挂载点**。Computer 的
[runtime 文档](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/05_runtime_interface.md)
把命令的前后边界描述为：

```text
push -> spawn -> events/result -> pull
```

`worker-shell` 不需要经过这套边界，因为它的文件系统 capability 可以直接访问作为唯一
事实源的 Workspace。container 做不到这一点：未经修改的 Linux 程序期待普通的文件
系统 syscall，因此 `computerd` 通过 FUSE 投射出第二个 VFS，并让它与 Durable Object
同步。

由此可以得到精确的存储模型：

> **一份作为唯一事实源的持久副本，加上一份只在需要时存在的执行侧临时物化副本。**

这不是 zero-copy。container 执行期间，同步过的文件可能同时存在于两侧。经济收益
来自让第二个执行环境保持临时，而不是假设它不存在。

**资料来源：** [Cloudflare Computer 发布文章](https://blog.cloudflare.com/cloudflare-computer/)、
[Cloudflare Sandbox GA](https://blog.cloudflare.com/sandbox-ga/)、
[Computer runtime 接口](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/05_runtime_interface.md)
和 [Cloudflare Containers 定价](https://developers.cloudflare.com/containers/pricing/)。

---

## 第 6 章：用两种模式构建同一个网站

> <u>**可运行证据：**</u>
> **isolate 负责编写和检查网站；只有 `npm install` 与 Vite 构建会启动 Linux。**

<p align="center">
  <img src="../assets/part-ii/build-website-two-modes.png" alt="网站经历四个阶段：在 isolate 中用 workspace.fs 编写，在 isolate 中用 just-bash 检查，在 Linux container 中用 npm 和 Vite 构建，再回到 isolate 中用 just-bash 验证。" width="40%" />
</p>

*图 2：网站沿着 isolate → isolate → container → isolate 的顺序移动。只有原生包安装与
构建需要 Linux。*

### 这个示例证明了什么？

完整项目位于
[`examples/dual-mode-website-builder`](../examples/dual-mode-website-builder/)。
它把 `@cloudflare/computer` 和 `computerd` 镜像固定在 `0.1.1`，避免教程在不知情的
情况下跟随持续变化的 preview API。

应用会执行四个可见步骤：

| 步骤 | 操作 | 执行后端 | 持久化效果 |
| --- | --- | --- | --- |
| **1. 编写** | 写入 Vite 源文件 | Durable Object isolate 中的 `workspace.fs` | 直接写入唯一事实源 |
| **2. 检查** | `find . -type f \| sort` | `just-bash` Worker isolate | 直接 RPC；没有同步副本 |
| **3. 构建** | `npm install && npm run build` | Linux container | 执行前 push；执行后 pull |
| **4. 验证** | 检查并 grep `dist/` | `just-bash` Worker isolate | 确认 pull 回来的输出已经持久化 |

### 如何注册两种执行后端？

核心接线代码有意保持精简。`Workspace` 接收 Durable Object storage handle，以及两个
惰性启动的执行后端：

```ts
import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceProxy, WorkspaceServiceProxy };

function workspaceRef(ctx: DurableObjectState) {
  return { binding: "SiteBuilder", id: ctx.id.toString() };
}

class SiteBuilderBase extends withWorkspaceContainer(
  class extends DurableObject<Env> {},
) {}

export class SiteBuilder extends SiteBuilderBase {
  readonly #containerBackend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: workspaceRef(this.ctx),
  });

  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "worker-shell",
        loader: this.env.LOADER,
        workspace: workspaceRef(this.ctx),
        ctx: this.ctx,
      }),
      this.#containerBackend,
    ],
  });

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ws") {
      return this.#containerBackend.handleFetch(request);
    }
    return new Response("not found", { status: 404 });
  }

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }
}
```

这里存在两条 loopback 路由：

- `WorkspaceServiceProxy` 允许运行 `just-bash` 的 Dynamic Worker 调用作为唯一事实源的
  Workspace。
- `WorkspaceProxy` 允许 container 中的 `computerd` 通过 container backend 的
  WebSocket 路径连接回来。

应用在服务端选择执行后端。调用者不能只修改一个请求字段，就把任意命令变成 container
操作。

### 不启动 container，如何编写文件？

源文件创建直接使用 `workspace.fs`：

```ts
await workspace.fs.rm("/workspace/site", {
  recursive: true,
  force: true,
});
await workspace.fs.mkdir("/workspace/site/src", { recursive: true });

await Promise.all(
  Object.entries(siteFiles(spec)).map(([relativePath, contents]) =>
    workspace.fs.writeFile(`/workspace/site/${relativePath}`, contents),
  ),
);
```

这些写入直接发生在 Durable Object SQLite 内的 VFS 上。项目拥有文件，并不意味着
container 已经存在。

### `just-bash` 如何检查持久化工作区？

第一个命令显式选择 isolate shell：

```ts
using inspection = await workspace.runtime.exec(
  "find . -type f | sort",
  {
    backend: "worker-shell",
    cwd: "/workspace/site",
    encoding: "utf8",
  },
);

const inspected = await inspection.result();
```

这段代码使用了 shell 语法，但它不是一个原生 Bash 进程。`WorkerShellBackend` 在
Dynamic Worker 中运行 `just-bash`，并通过 RPC 调用 Workspace 文件系统 capability。
它的结果会报告 0 个 pushed 和 pulled 条目，因为这里没有第二个文件系统需要同步。

### 工作流何时升级到 Linux？

构建步骤只改变执行后端 ID 与命令：

```ts
using build = await workspace.runtime.exec(
  "npm install --no-audit --no-fund && npm run build",
  {
    backend: "container",
    cwd: "/workspace/site",
    encoding: "utf8",
  },
);

const result = await build.result();

if (result.exitCode !== 0 || result.sync.status !== "complete") {
  throw new Error("The build or its post-command synchronization failed");
}
```

调用 `result()` 很重要。Computer 会在结果 settled 之前完成命令后的 pull。Linux
命令可能成功退出，但同步仍可能无法完成，因此应用需要同时检查 `exitCode` 和
`result.sync.status`。

container 镜像也同样精简：

```dockerfile
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
ENTRYPOINT ["/usr/local/bin/computerd"]
```

`computerd` 是 container entry point。Node 与 npm 是 container 镜像提供的 capability，
不是 Code Mode 或 `just-bash` 的能力。

### 如何从 isolate 验证 container 输出？

构建结果 settled 时，`dist/` 已被 pull 回作为唯一事实源的 Workspace。示例随后再次
切换到 `worker-shell`：

```ts
using verification = await workspace.runtime.exec(
  'find dist -type f | sort && grep -R "Dual-mode build" dist',
  {
    backend: "worker-shell",
    cwd: "/workspace/site",
    encoding: "utf8",
  },
);

const verified = await verification.result();
```

应用会直接从 Workspace VFS 提供这些经过验证的文件。因此，preview 不只证明了
container 命令成功，还证明构建产物已经跨过持久化边界。

### 如何在本地运行示例？

环境要求：

- Node.js 22 或更高版本
- Docker Desktop
- Wrangler 已完成身份验证，以使用 Computer 所依赖的 Cloudflare 远程功能
- 在 Windows 上使用 Wrangler Containers 开发时需要 WSL

安装教程自身的依赖，并执行类型检查：

```powershell
cd cloudflare\computer\examples\dual-mode-website-builder
npm install
npm run types
npm run typecheck
```

在 Linux、macOS 或受支持的 Cloudflare 开发环境中：

```bash
npm run dev
```

在 Windows 上，请启用 Docker Desktop 的 WSL integration，然后通过 WSL 启动：

```powershell
wsl --cd /mnt/c/path/to/dual-mode-website-builder `
  bash scripts/dev-wsl.sh 8793
```

打开 <http://127.0.0.1:8793/> 并选择 **Build website**。界面会显示每一步选用的
执行后端、耗时、push 数量、pull 数量和同步状态。

> 第一次构建包括镜像构建、container 启动和 npm 安装，因此它比 isolate 文件编辑慢
> 很多是正常现象。

**资料来源：** [可运行的网站构建器](../examples/dual-mode-website-builder/)、
[完整 Worker 源码](../examples/dual-mode-website-builder/src/index.ts)、
[固定版本的 container 镜像](../examples/dual-mode-website-builder/Dockerfile)，以及
Cloudflare Computer 的 [`examples/think`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/examples/think)。

---

## 第 7 章：跟随一条命令跨越持久化边界

> <u>**持久化边界：**</u>
> **进程成功退出还不够；命令结束后的 pull 也必须完成。**

### 从 `runtime.exec()` 到持久化输出之间发生了什么？

container 路径并不是把 Cloudflare 生产环境的 Durable Object 数据库直接挂载为
FUSE。它是在两个 VFS 实例之间进行同步：

```text
                  AUTHORITATIVE WORKSPACE
                Durable Object SQLite VFS
                           |
                           | 1. push changed paths
                           |    and missing chunks
                           v
        +--------------------------------------------+
        | CONTAINER                                  |
        |                                            |
        | npm / Vite                                 |
        |    |                                       |
        |    +-> Linux syscalls -> FUSE              |
        |                           |                |
        |                           v                |
        |                    computerd local VFS     |
        +---------------------------+----------------+
                                    |
                                    | command exits
                                    | 2. pull changed paths
                                    |    and missing chunks
                                    v
                Durable Object SQLite transaction
                                    |
                                    v
                            DURABLE OUTPUT
```

```text
FUSE write       command exit       pull pending       SQLite commit
    |                 |                  |                   |
visible locally   process success    not yet durable     durable
```

> **进程成功与持久化成功是两个独立结果。**

Computer 的
[同步协议文档](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md)
会增量传输 manifest（清单）与内容寻址的 chunks。执行前，Durable Object push
container 尚未见过的路径。执行后，它获取 container 侧的变更，只请求缺失的 chunks，
然后把已经提交的批次应用到 SQLite。

### 写入在什么时候变得持久？

| 时刻 | 命令能看到文件吗？ | 文件是唯一事实源吗？ | container 丢失后安全吗？ |
| --- | ---: | ---: | ---: |
| 命令开始前 | 是，push 后可见 | 是，上一版本 | 是 |
| FUSE 写入期间 | 是 | 还不是 | 否 |
| 命令退出、pull 待处理 | 是 | 不一定 | 不一定 |
| pull 提交到 DO SQLite | 是 | 是 | 是 |
| container 休眠或消失 | 不再需要本地副本 | 是 | 是 |

这就是为什么 `exitCode === 0` 并不足够。应用必须拿到已完成的同步结果，才能宣称
持久化成功。

### `node_modules` 会怎样？

Computer 的
[默认 container 同步规则](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md#ignored-entries)
会忽略 `node_modules`。这是一个重要的空间与延迟决策：一次 `npm install` 可能创建
数万个小文件，它们对构建很有用，却不适合作为持久工作区的同步对象。

```text
package.json   ----pull----> Durable Object
package-lock   ----pull----> Durable Object
src/           ----pull----> Durable Object
dist/          ----pull----> Durable Object
node_modules/  --ignored--> container-local and disposable
```

这样便把**持久项目产物**与**可重新构建的执行缓存**清晰分开。

### 同步失败时怎么办？

runtime 结果可能报告：

```ts
{
  exitCode: 0,
  sync: {
    status: "pending",
    error: "..."
  }
}
```

原生命令已经成功，但它的变更还没有在 Workspace 中得到确认。正确做法是重试同步或
协调两侧状态，而不是盲目重跑一个可能不具备幂等性的命令。

**资料来源：** 固定版本的[同步协议](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md)、
[runtime 结果契约](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/05_runtime_interface.md)，
以及 [`runtime.exec()` 实现](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/runtime/runtime.ts)。

---

## 第 8 章：计算 80% 的成本降幅

> <u>**模型估算结果：**</u>
> **在这个场景中，10% 的 container 活跃时间占比会产生 $7.53 的成本，而不是
> $36.83。改变活跃时间占比，降幅也会随之改变。**

### 哪些假设得出了 80%？

标题中的 80% 来自一个透明的月度成本模型。它比较的是两种 Cloudflare 架构，而不是
拿 Cloudflare 部署与一台无关的 VPS 比较：

1. 一台 `standard-1` Cloudflare Container 整月保持活跃。
2. 同一台 container 只在当月 10% 的时间里活跃，普通工作由 Workers 和一个
   Workspace Durable Object 处理。

| 输入 | 数值 |
| --- | ---: |
| 月份 | 30 天 / 720 小时 |
| Container | `standard-1` |
| 预配容量 | 0.5 vCPU、4 GiB 内存、8 GB 磁盘 |
| 运行期间的平均 CPU 消耗 | 0.5 vCPU 的 20% |
| 双模式 container 时间 | 72 小时 / 10% |
| 持久工作区 | 不超过 5 GB-month |
| Worker 用量 | 不超过 1000 万次请求和 3000 万 CPU-ms |
| Durable Object 用量 | 不超过套餐内请求与持续时间额度 |
| 网络与日志 | 无超额用量 |

截至 2026 年 8 月，[$5 Workers Paid 套餐及其 container 额度](https://developers.cloudflare.com/containers/pricing/)
包含 25 GiB-hours 的 container 内存、375 vCPU-minutes 和 200 GB-hours 的磁盘。
超额费率分别是：每 GiB-second 内存 $0.0000025、每 active vCPU-second
$0.000020，以及每 GB-second 磁盘 $0.00000007。Cloudflare 在 container 活跃期间
对内存与磁盘收费；CPU 则按实际活跃用量计费。

换算为下文使用的单位：

| 资源 | 换算后的超额费率 |
| --- | ---: |
| 内存 | 每 GiB-hour $0.009 |
| 活跃 CPU | 每 vCPU-minute $0.0012 |
| 磁盘 | 每 GB-hour $0.000252 |

### 始终活跃的基线成本是多少？

| 费用 | 计算方式 | 成本 |
| --- | --- | ---: |
| Workers Paid 套餐 | 固定月度最低费用 | $5.00 |
| 内存 | `(4 x 720 - 25) x $0.009` | $25.70 |
| 磁盘 | `(8 x 720 - 200) x $0.000252` | $1.40 |
| CPU | `(0.5 x 20% x 720 x 60 - 375) x $0.0012` | $4.73 |
| 不超过 5 GB-month 的 DO 存储 | 套餐内包含 | $0.00 |
| **总计** | | **$36.83/月** |

### 10% 的 container 活跃时间占比会花多少钱？

| 费用 | 计算方式 | 成本 |
| --- | --- | ---: |
| Workers Paid 套餐 | 固定月度最低费用 | $5.00 |
| 内存 | `(4 x 72 - 25) x $0.009` | $2.37 |
| 磁盘 | `(8 x 72 - 200) x $0.000252` | $0.09 |
| CPU | `(0.5 x 20% x 72 x 60 - 375) x $0.0012` | $0.07 |
| 不超过 5 GB-month 的 DO 存储 | 套餐内包含 | $0.00 |
| **总计** | | **$7.53/月** |

```text
Estimated monthly cost                     each # is approximately $1

Always active |#####################################| $36.83
10% duty      |########                             |  $7.53

Estimated saving: $29.30 per month
Estimated reduction: 79.6%
```

container 的可变费用从 $31.83 降至 $2.53。完整账单不会恰好降到 10%，因为每月
$5 的 Workers Paid 最低费用仍然存在。

### 结果对 container 唤醒时间有多敏感？

保持其他假设不变：

| Container 活跃时间占比 | 估算月度成本 | 相比始终活跃的降幅 |
| ---: | ---: | ---: |
| 5% | $6.09 | 83.5% |
| **10%** | **$7.53** | **79.6%** |
| 25% | $12.41 | 66.3% |
| 50% | $20.55 | 44.2% |
| 100% | $36.83 | 0% |

所以，标题只适用于接近 10% 这一行的工作负载。如果 container 在一半工作流中都必不可少，
同一模型只能节省约 44%，而不是 80%。

### Durable Object Storage 会增加多少成本？

[基于 SQLite 的 Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
在付费套餐中包含 5 GB-month，超出后每 GB-month 收费 $0.20。在其他操作额度相同的
情况下：

| 持久工作区 | 存储超额费用 | 双模式估算 |
| ---: | ---: | ---: |
| 1 GB | $0.00 | $7.53 |
| 5 GB | $0.00 | $7.53 |
| 8 GB | $0.60 | $8.13 |
| 10 GB | $1.00 | $8.53 |

这个表描述的是计费中的 live data，不包括 Computer 在重写与垃圾回收窗口期间产生的
临时存储放大。第一部分已经单独分析了固定 512 KiB chunk 的权衡。

### 双模式何时占优，又何时不占优？

#### 非常适合

| 工作负载特征 | 双模式为什么有帮助 |
| --- | --- |
| 大量读取、搜索和小编辑 | 它们留在 isolate 路径中 |
| 工具调用之间有较长等待 | container 无需保持唤醒 |
| 偶尔安装软件包 | Linux 只在该阶段启动 |
| 可以重新构建的依赖缓存 | `node_modules` 可以保持一次性 |
| 需要持久化的源码与构建产物 | 有用路径会同步回 SQLite |
| 突发式 Agent 会话 | Durable Objects 与 containers 都可以进入空闲状态 |

#### 不太适合

| 工作负载特征 | 为什么节省会缩小 |
| --- | --- |
| 每个操作都需要原生二进制文件 | container 活跃时间占比接近 100% |
| 持续运行开发服务器 | container 会一直保持活跃 |
| 反复安装大量依赖 | 启动和重建成本占据主导 |
| 持续修改大型工作区 | 同步流量会增长 |
| 被忽略路径中的大量写入必须持久化 | 默认持久化边界不合适 |
| 每个工作区有多个并发写入者 | 冲突策略需要明确设计 |

路由规则可以保持简单：

```text
Does this operation require native Linux or a retained OS process?
                         |
                  +------+------+
                  |             |
                 no            yes
                  |             |
        Durable Object or       container
          Worker isolate        push -> exec -> pull
```

不要只根据命令的拼写做路由。一个小脚本也可能调用原生二进制文件、需要外部网络访问，
或者依赖有意保留在 container 内的状态。执行位置是 capability 与生命周期决策。

**资料来源：** [Cloudflare Containers 定价](https://developers.cloudflare.com/containers/pricing/)、
[Cloudflare Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)，以及
[Cloudflare Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

---

## 应该记住什么？

Cloudflare Computer 并没有消灭沙箱。它只是把沙箱从一个始终运行的“家”，变成一个
按需启用的兼容工具。

整个模型可以压缩为四句话：

| 原则 | 实际含义 |
| --- | --- |
| **Durable Objects 持有项目。** | 作为唯一事实源的文件可以在一次性执行环境消失后继续存在。 |
| **Isolates 处理常用路径。** | 读取、搜索、写入和可移植 shell 工作不必启动 Linux。 |
| **Containers 负责兼容性。** | 只有操作确实需要时才启动原生工具。 |
| **同步确认持久性。** | 不要把进程退出等同于工作区已经持久化成功。 |

对于本教程中的网站，源码编写与验证都不需要 Linux。只有依赖安装与打包会进入
container。如果这种模式能让 container 每月只活跃大约 10% 的时间，那么本文模型
估算的沙箱成本可以降低约 80%。

真正的结论并不是“containers 很糟糕”，而是更精确的一句话：

> <u>**结论：**</u>
> **只在操作确实需要完整操作系统时为它付费，而不是仅仅因为 Agent 拥有一个工作区。**

## 运行、检查与验证

- [可运行的双模式网站构建器](../examples/dual-mode-website-builder/)
- [完整 Worker 源码](../examples/dual-mode-website-builder/src/index.ts)
- [固定版本的 container 镜像](../examples/dual-mode-website-builder/Dockerfile)
- [第一部分：Cloudflare Durable Objects 入门](PART-I.zh-CN.md)

Cloudflare Computer 仍是 preview 软件。API、限制、计费和 runtime 行为都可能变化。
在把本文模型用于生产预算之前，请重新核对本章引用的资料。
