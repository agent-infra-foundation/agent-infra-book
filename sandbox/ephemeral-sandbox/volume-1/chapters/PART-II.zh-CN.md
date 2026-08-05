# 第 II 部分 — LayerStack 与共享项目历史

[English](PART-II.md) | **简体中文**

*一份持久的文件系统历史，如何为大量并发 workspace session（“工作空间会话”）提供稳定基线。*

> **术语约定：** 为了便于对照 API、源代码和英文资料，容易产生歧义的系统术语会在首次定义时采用 `English（“中文”）` 形式；产品名、协议名和代码标识符不翻译。

第 I 部分停在工作空间边界：一项编码任务应该获得稳定的项目基线、私有执行状态，以及明确的结束方式。第 II 部分进入这条边界之下，从每个工作空间都会使用的历史开始。

核心模型很小：

> **一个 sandbox（“沙箱”）、一份共享 LayerStack，以及许多短生命周期的私有 workspace session。**

智能体变多，并不会让历史本身变成可写状态。每项工作只会租用 LayerStack 中一个已经记录的时间点，session lifecycle（“会话生命周期”）则保留这份视图属于哪项任务。第 III 部分会在这份 lease（“租约”）之上构建真正运行命令的 COW（copy-on-write，“写时复制”）工作空间。

我们会跟随两个从已发布修订 R42 开始的任务：

```text
已发布 head：R42

智能体 A
  请求 Q91
  automatic workspace S17
  命令 C31

智能体 B
  explicit workspace S18
  文件编辑
  命令 C32
  命令 C33

之后，共享 head 前进到 R43。
S18 仍然看到它租用的 R42 基线，以及自己的 private delta（“私有增量”）。
```

这些标识符并非装饰。它们防止“智能体改了这个文件”成为最后仅存的解释。

---

## 第 12 章 — 一个 LayerStack，多个 Workspace Session

两项编码任务进入同一个 sandbox。智能体 A 更新 parser 依赖，智能体 B 修改使用该依赖的服务器代码。它们需要相同的仓库、工具链和已发布历史，却不需要共用同一个可写目录。

把它们放在同一张工作台上，确实很“高效”——就像让两名机械师共用一盘散装螺丝：省下了一只托盘，也失去了一份可信的零件清单。

Ephemeral Sandbox 会把应该共享的内容与应该私有的内容分开。持久项目历史保存在 **LayerStack** 中。每项活跃任务都会得到一个 **workspace session**：它是 LayerStack 某个已记录时间点的临时可写投影。命令在这份投影中运行；只有被接受的结果，才能回到共享历史。

### 四个对象，四种生命周期

人们经常用 *sandbox* 指代盒子里的一切。只有一个任务时，这种简称很方便；多个生命周期彼此重叠后，它就会变得昂贵。

**sandbox** 是受管理的运行时边界。它拥有更大的环境：运行时状态、工作空间根目录、daemon（“守护进程”），以及运行时操作访问的 endpoint（“端点”）。一个 sandbox 可以比许多单独任务活得更久。

**LayerStack** 是 sandbox 内部持久的文件系统历史。它保存由不可变 layer（“层”）组成的有序 manifest（“清单”）。已发布工作通过增加新的不可变 layer 改变活跃历史；运行一条命令不会原地修改旧 layer。

**workspace session** 是一份 LayerStack 租用历史的临时可写视图。它的 private delta 可以在任务工作时不断变化，其他 session 看不到这些尚未完成的修改。

**command session（“命令会话”）** 的范围更窄。它标识一个正在运行的进程及其 transcript（“执行记录”）。一个 workspace session 可以包含多个 command session；命令可以结束，而容纳它的工作空间仍然保持私有。

| 对象 | 生命周期 | 是否可变 | 职责 |
| --- | --- | --- | --- |
| Sandbox | 受管理的运行时生命周期 | 运行时状态会变化 | 承载工作空间执行 |
| LayerStack | 持久项目历史 | 单个 layer 不可变 | 保存已发布的文件系统事实 |
| Workspace session | 临时任务生命周期 | 它的 private delta 可变 | 提供一份私有项目视图 |
| Command session | 进程生命周期 | 进程与 transcript 状态会变化 | 跟踪一条命令及其 I/O |

这种区分会立刻影响系统行为。销毁命令 C32 不应该擦除智能体 B 在 S18 中的私有文件；销毁 S18 不应该擦除 R42；发布 S17 也不应该暴露智能体 B 尚未完成的编辑。每项操作只作用于它真正拥有其生命周期的对象。

[官方 Core Concepts 文档](https://ephemeral-sandbox.com/docs/concepts)采用相同的划分：文件系统 publication（“发布”）属于 workspace session，而进程与 transcript 状态属于 command session。

### 持久的 Stack 与临时的 View

在 R42，智能体 A 和 B 可以从同一份不可变 lower history（“下层历史”）开始：

```text
R42 的 LayerStack
    ├── workspace S17 + private delta A
    └── workspace S18 + private delta B
```

两个 session 共享已经属于 R42 的字节。它们不会把这些字节复制成两份完整仓库，也不会把修改写回 R42。S17 把智能体 A 的变更记录在自己的可写状态中；S18 对智能体 B 的工作做同样的事。

如果 S17 成功发布，active head（“活跃头部”）可能变成 R43。S18 不会在命令 C32 下方突然改变。它的 lease 仍然指向开始时的那份确切历史；publication logic（“发布逻辑”）可以在之后把它的候选结果与更新后的 head 比较。

这为第 II 部分提供四条 invariant（“不变量”）：

> **历史是共享的。**
> 许多 session 可以复用已经发布的 layer。

> **执行视图来自 lease。**
> 活跃工作空间会保留它开始时那份确切的 lower-layer history。

> **变更是私有的。**
> 写入与删除会停留在 session 的 COW 状态中，直到 capture（“捕获”）与 publication。

> **发布是原子的。**
> 经过解析的候选结果要么作为一个完整 layer 进入共享历史，要么完全不进入。

共享历史、lease 与 session lifecycle，就是本部分的主题。第 III 部分会先把 lease 转换成私有 COW 工作空间，再继续讨论执行、capture、resolution（“解析”）与 publication。

![一份不可变 LayerStack 为三个独立的私有 workspace session 提供历史；每个 session 只有一个小型 private delta，被接受的发布则向共享历史返回一个新 layer。](../assets/diagrams/part-2/12-01-one-layerstack-many-sessions.svg)

*图 12.1 — 许多任务可以共享一份已发布历史，而不共享尚未完成的文件系统变更。*

![三个编码智能体在一个 sandbox 中并发运行。每个智能体都在同一份 LayerStack lease 之上使用独立 workspace session；observability 记录运行状态，被接受的变更通过 OCC publication gate。](../assets/diagrams/part-2/12-02-three-agents-one-sandbox.png)

*图 12.2 — 三个智能体可以在同一个 sandbox 内并发运行而不共享可写工作空间；每个 session 都通过 OCC publication gate（“发布关口”）发布。*

### 共享历史，不等于共享 Checkout

这套模型不会退回第 I 部分拒绝的 shared mutable workspace（“共享可变工作空间”）。智能体共享的是**已发布事实**，而不是一棵活跃的可写目录树。智能体 B 可以检查智能体 A 所使用的同一份已接受 parser 代码，却不会看到智能体 A 重写 lockfile 到一半的状态。

它也不同于为每项任务复制整个项目。目录复制可以提供私有文件，但会重复基础数据，也会失去与共享分层历史之间的显式关系。workspace session 表达的是：

```text
我看到的项目 = 租用的共享历史 + 我的 private delta
```

因此，session 不只是一份目录。它把 base revision（“基线修订”）、lease、可写投影、namespace boundary（“命名空间边界”）、命令归属和结束方式绑定在一起。智能体得到的是一张私有工作桌，而不是整栋楼的私人副本。

这套模型并不声称 workspace session 是抵御 hostile tenant（“恶意租户”）的 hardened boundary（“强化安全边界”）。Ephemeral Sandbox v1 面向相互协作的编码智能体。外围的 container、VM、凭证与网络策略，仍然决定什么代码可以安全运行。这里的问题更窄：并发任务如何避免共享尚未完成的项目状态。

第一个答案就是 LayerStack：每个临时工作空间开始时所依赖的持久历史。

---

## 第 13 章 — LayerStack：不可变共享历史

在 R42，智能体 A 与智能体 B 都打开 `src/server.rs`。两个 session 都没有复制整个项目，也都无法重写 R42。在各自的私有工作空间修改这条路径之前，它们看到的是同一份已发布文件。

这种行为从工作空间下方的 LayerStack 开始。

**LayerStack 是一份由不可变文件系统 layer 组成的有序 manifest。** 一个 layer 可以包含文件、目录、符号链接和删除元数据。manifest 定义哪些 layer 构成当前已发布视图，以及读取时应该采用什么优先顺序。

LayerStack 拥有历史、lease 与 publication state（“发布状态”）。它不会启动 shell，也不会隔离进程。存储系统不应该兼职做进程 supervisor（“监督器”）。

### 三类不可变 Layer

可见历史包含三种 layer role（“层角色”）：

| Layer 类型 | 用途 | 创建后是否可变 |
| --- | --- | --- |
| Base，`B*` | 初始的 content-addressed project state（“内容寻址项目状态”） | 否 |
| Published，`L*` | 已接受的文件系统 delta | 否 |
| Squashed，`S*` | 旧历史的等价紧凑表示 | 否 |

例如 `B000001-base` 这样的 base layer 提供初始项目内容。publication 接受 changeset（“变更集”）后，会创建一个新的 `L*` layer，并把它放到 manifest 最前面。之后，squash（“压缩”）可以把一段符合条件的旧 published layer 替换成等价的 `S*` layer。squash 改变物理布局，不改变逻辑项目视图。

第 III 部分会解释这些状态转换。目前最重要的属性是：这些 layer 目录都不是共享草稿区。一旦出现在 manifest 中，它们的内容就是历史。

### 最新优先，第一个可见路径获胜

LayerStack manifest 按照 newest first（“最新优先”）排序。假设 R42 包含：

```text
L000042       最新发布的 delta
S000041       已压缩的早期历史
B000001-base  原始项目内容
```

读取 `src/server.rs` 时，系统会按照这个顺序搜索。第一个可见版本获胜。如果 L42 包含该文件，更旧的版本就会被遮蔽；如果没有，读取会继续落到 S41，再落到 B1。新 layer 中的删除标记，也可以隐藏物理上仍然存在于下层的路径。

这一顺序出现在 [LayerStack Architecture](https://ephemeral-sandbox.com/architecture/layerstack) 中，并一直保留到 OverlayFS：publication 会把最新 layer 放到最前面，lease 会复制这份顺序，而 overlay mount（“叠加挂载”）则赋予第一个 lower path（“下层路径”）最高优先级。

因此，layer ordering（“层顺序”）不只是展示方式。数组顺序最终会变成文件系统事实。

### Revision 不只是一个方便阅读的数字

active manifest（“活跃清单”）包含 version、按顺序排列的 layer reference（“层引用”）以及 schema version。Ephemeral Sandbox 还会根据按序排列的 layer identity（“层身份”）与路径计算 root hash（“根哈希”）。manifest version、root hash 和 layer count 共同描述工作空间持有的 base revision。

version 便于人类阅读和日志记录；root hash 保护更重要的事实：究竟是哪一份有序历史生成了当前视图。包含相同 layer、但顺序不同的两份 manifest，并不表示同一个文件系统。

在当前示例中，S18 可以记录：

```text
workspace session：S18
manifest version：42
root hash：H42
lower-layer count：3
```

这比“它大约在 R42 仍是 current revision 时开始”更精确。它明确指出智能体 B 的 private delta 是相对于哪一份项目状态才有意义。

### Lease 保住 Session 脚下的地板

工作空间启动时，LayerStack 会获取一份 snapshot（“快照”）和一个 **lease**。lease 包含 manifest 及其解析后的 lower-layer path。只要 session 仍然存活，它就会让这份历史保持可用。

S18 不会开始读取 R42 与后续修订混合而成的状态。它的 lower chain（“下层链”）始终是 lease 指定的那一份。当 S18 最终提出 changeset 时，publication 可以把候选结果所租用的 base 与当时的 active head 比较。

lease 不是全局项目锁。它不会阻止 S17 发布，也不会阻止新 session 使用 R43。它保护的是 reader（“读取者”）所需的稳定历史，并防止存储清理回收仍被活跃视图使用的 layer。

图书馆类比只在这一段有效：一名读者借走某个明确版本，图书馆仍然可以收到更新版本。借阅不会禁止新书入库，只会防止有人在读者阅读时替换第 80 页。说完以后，请继续叫它 lease——内核并不管理图书。

### 不同 Session 可以租用不同 Revision

假设智能体 A 从 R42 开始。智能体 B 启动前，另一次 publication 创建了 R43；智能体 C 启动前，又一次 publication 创建了 R44。三个 session 可以同时保持活跃，但它们读取的并不是同一条 lower chain：

```text
智能体 A：lease R42 → [L42, S40, B1]             + private ΔA
智能体 B：lease R43 → [L43, L42, S40, B1]        + private ΔB
智能体 C：lease R44 → [L44, L43, L42, S40, B1]   + private ΔC
```

lease 时间点所指向的 layer，只是该 revision 中最新的一层。可见项目来自它下方完整的有序 chain。每个智能体随后增加自己的 private delta，而不重写任何共享 layer。

![一份 newest-first LayerStack 包含 L44、L43、L42、S40 与 B1。智能体 C 租用 R44，智能体 B 租用 R43，智能体 A 租用 R42；每个智能体都在自己的稳定历史之上获得私有工作空间与 private delta。](../assets/diagrams/part-2/13-01-different-leased-revisions.svg)

*图 13.1 — 智能体可以租用不同的 LayerStack revision，同时让尚未完成的变更保持私有。*

lease 选择不可变历史。第 15 章会使用 OverlayFS，把这份租用历史转换成智能体可写的工作空间。

### 共享 Base 只消除一项成本

当 N 个 session 从相同历史开始时，LayerStack 避免产生 `N × base` 份仓库副本。物理 base 内容可以共享，而每个 session 只为自己的元数据和 COW 变更付出成本。

这并不意味着 session storage（“会话存储”）是常数。如果十个智能体分别重写不同的 100 MB 生成文件，private delta 仍然需要保存这些被复制的文件。command transcript、进程与运行时元数据也会随 session 数量增长。

诚实的存储模型是：

```text
一份共享 base
+ 被保留的 published history
+ 所有 private delta 之和
+ 每个 session 的运行时元数据
```

layer count 也有成本。创建工作空间时，系统必须构造有序 lower-path list；读取路径时，也可能要穿过多层才能找到可见版本。squash 可以缩短旧 chain，但它是一项维护操作，不是每条命令结束后都会发生的魔法压缩。

更准确、也更有力的结论是：**许多工作空间可以引用同一份不可变项目历史，而不必复制或修改这份历史。**

### LayerStack 不保证什么

不可变 layer 无法阻止进程消耗内存；lease 无法阻止命令打开端口；root hash 也无法判断依赖升级是否正确。这些责任分别属于 execution（“执行”）、resource policy（“资源策略”）、validation（“验证”）与 publication。

LayerStack 提供工作空间等式中稳定的一半。下一章会提供临时 owner（“所有者”）：一个生命周期与正在执行的工作相匹配的 workspace session。

---

## 第 14 章 — Automatic 与 Explicit Workspace Session

智能体 A 只需一条命令更新生成的 parser table。智能体 B 则需要一段连续操作：编辑 `src/server.rs`、运行一个聚焦测试、检查失败、继续修改文件，然后再次运行测试。

为每个*智能体*分配一个永久工作空间听起来很简单，但这不是正确的工作单元。一个智能体可能处理十个互不相关的请求；同一项任务也可能需要多个彼此相关的 tool call。ownership（“归属”）应该跟随有边界的工作，而不是碰巧发出请求的模型进程。

Ephemeral Sandbox 支持两种 workspace lifecycle：面向独立命令的 automatic session（“自动会话”），以及面向相关操作的 explicit session（“显式会话”）。

### Automatic Workspace：一条独立命令

当 `exec_command` 请求不包含 `workspace_session_id` 时，运行时会创建一个 automatic workspace session。它采用固定的 finalization policy（“收尾策略”）：`publish_then_destroy`。

用普通语言表示：

```text
独立 exec_command
        ↓
创建私有工作空间
        ↓
运行命令
        ↓
capture 并尝试 publication
        ↓
销毁临时工作空间
```

智能体 A 的请求 Q91 会变成 automatic workspace S17 和命令 C31。调用者不必仅仅为了在私有项目状态中运行一条有边界的命令，就额外管理一套创建与销毁流程。

`publish_then_destroy` 描述的是顺序，而不是保证结果一定会被接受。session 中最后一条命令到达 terminal state（“终止状态”）后，运行时会尝试 capture 并发布它的文件系统变更，记录 publication 或 finalization failure（“收尾失败”），然后拆除临时工作空间。冲突可以拒绝 publication。“然后销毁”并不表示“不计代价也要发布”。

这就是独立命令执行中已经实现的 workspace-at-the-tool-call boundary（“每次工具调用一个工作空间边界”）。它让小请求继续保持简单，同时为它的文件、进程、base、transcript 和结束方式指定 owner。当前 operation contract（“操作契约”）记录在 [Runtime Command Catalog](https://ephemeral-sandbox.com/docs/reference/operations#runtime-command) 中。

### Explicit Workspace：一组相关操作

智能体 B 的任务无法拆成互不相关的 clean-room command（“净室命令”）。第二次测试必须看到第一次测试前完成的编辑。因此，这些操作会主动指向 explicit workspace S18：

```text
基于租用 R42 的 workspace S18
        ↓
文件编辑
        ↓
命令 C32
        ↓
检查输出与私有文件
        ↓
第二次编辑
        ↓
命令 C33
        ↓
显式 finalization
```

传入 `workspace_session_id: S18`，会让命令与文件操作使用已经存在的 mounted view（“挂载视图”）。C32 创建的文件对 C33 仍然可见，因为两条命令都属于 S18；其他 session 仍然无法看到它们。

在 v1 中，explicit workspace lifecycle operation 属于 internal coordination surface（“内部协调接口面”），而不是公开 CLI 或 MCP tool。公开运行时调用可以指定已有 session ID；创建、capture、finalization 与 teardown（“拆除”）则由运行时的协调层拥有。说明这一点，可以避免本书虚构一个文档目录中并不存在的公开 `create_workspace` 命令。

explicit session 使用 no-op automatic finalization policy（“空操作自动收尾策略”）：一条命令结束时，不会发布并销毁工作空间。multi-operation task（“多操作任务”）准备好后，由它的 owner 决定何时收尾。

### Session ID 会改变 File Operation 的含义

公开运行时接口会明确区分包含和不包含 workspace session ID 的调用：

| 操作 | 不带 `workspace_session_id` | 带 `workspace_session_id` |
| --- | --- | --- |
| `exec_command` | 创建 automatic `publish_then_destroy` workspace session | 在指定的现有 workspace 中运行 |
| `file_read` | 读取最新 published snapshot（“已发布快照”） | 读取指定的私有 workspace |
| `file_write` / `file_edit` | 发布一个归属于 `operation:<request_id>` 的 layer | 修改指定 workspace，并在 capture 前保持私有 |

这张表可以阻止两种常见误解。

第一，“workspace session per tool call（“每次工具调用一个工作空间会话”）”是对独立 `exec_command` 的准确简称，却不是所有运行时操作的统一描述。不带 session 的 file write 不会创建 automatic workspace，而会直接发布一个 operation-attributed layer（“操作归属层”）。不带 session 的 file read 完全不需要可写状态；它只会投影最新的 published snapshot。

第二，添加 session ID 并非一种无关紧要的路由装饰。它会改变操作可以观察哪份状态，也会改变修改是否保持私有。不带 S18 读取 `src/server.rs`，会在 head 前进后看到已发布的 R43；带 S18 读取同一路径，则会看到租用的 R42 加上智能体 B 的私有编辑。

[官方 Operation Catalog](https://ephemeral-sandbox.com/docs/reference/operations)与 [Core Concepts 文档](https://ephemeral-sandbox.com/docs/concepts)明确记录了这些行为。

> *⏳ **Tool-call boundary rule（“工具调用边界规则”）：** 一条独立命令会获得一个 automatic private workspace。主动属于同一项任务的操作，则会指向同一个 explicit workspace。*

直接、不带 session 的 file path 适合很小、很明确，并且应该立刻成为 published state 的修改。它的代价也同样直接：它不提供一段私有的 multi-operation period（“多操作阶段”），让智能体可以先编辑、测试和修订，再决定 publication。是否加入 workspace-session ID，选择的是一套生命周期，而不只是一种更冗长的请求格式。

![两列生命周期对比：automatic command 获得一个临时 workspace，在销毁前发布或拒绝；explicit workspace 则跨越一次编辑和两条命令持续存在，直到主动 finalization。](../assets/diagrams/part-2/14-01-automatic-vs-explicit-sessions.svg)

*图 14.1 — 独立命令获得 automatic temporary workspace；彼此相关的操作会主动复用一个 explicit session。*

### 为什么 Task Boundary 优于 Agent Boundary

假设智能体 A 收到三项互不相关的操作：

1. 重新生成 parser；
2. 检查 license 文件；
3. benchmark 一条测试命令。

如果把三项操作都放入同一个 agent-owned workspace（“智能体所有工作空间”），parser 输出可能影响 benchmark，license read 也会依赖它从不需要的私有状态。把独立命令分配到不同 automatic command session，可以获得更清楚的归属关系，减少意外依赖。

现在假设智能体 B 的修复需要一次编辑和两次测试。如果为每次调用分配完全无关的工作空间，编辑会在两条命令之间消失。explicit session 可以保留这份有意建立的依赖。

真正有用的 ownership rule（“归属规则”）是：

> *一个 workspace session 属于一个有边界的文件系统工作单元。这个单元可以是一条独立命令，也可以是数个主动关联的操作。*

这条规则可以与不同的 agent architecture（“智能体架构”）组合。一个模型进程可以拥有多个 session；orchestrator（“编排器”）可以在保留同一 workspace identity 的情况下，把任务转交给不同模型；reviewer（“审查者”）可以检查 session 而不成为它的作者。“智能体 B 的文件夹”会变成更准确的描述：“基于 R42、服务于这项任务的 workspace S18”。

### Lifecycle Edge 也是正确性的一部分

automatic 与 explicit session 的失败方式不同，因此它们的结束状态必须保持可见。

如果 automatic command C31 仍在运行，S17 就必须保持存活。如果 C31 已经退出，但 capture 失败，运行时必须报告 finalization failure，而不是成功 publication。如果 publication 被拒绝，共享历史必须保持不变，即使命令本身已经成功。

对于 explicit S18，命令 C32 可以失败，而工作空间仍然有用。智能体可以检查私有文件和 transcript、运行 C33，或者放弃任务。销毁 S18 会丢弃未发布状态；C32 结束则不会。

因此，process exit code（“进程退出码”）不能代表 workspace status：

```text
command status：success
workspace status：still private
publication status：not attempted
```

现在，workspace session 已经拥有稳定 base 与精确 lifecycle。第 II 部分回答了任务从什么状态开始，以及谁拥有 lease。第 III 部分会从下一条边界开始：如何把租用历史转换成私有可写文件系统视图，同时避免复制完整项目。

---

## 参考资料

1. Ephemeral Sandbox，[“Agent Sandbox for Parallel Coding Agents”](https://ephemeral-sandbox.com/)。
2. Ephemeral Sandbox，[“Core Concepts”](https://ephemeral-sandbox.com/docs/concepts)。
3. Ephemeral Sandbox，[“Operations Reference”](https://ephemeral-sandbox.com/docs/reference/operations)。
4. Ephemeral Sandbox，[“Architecture Overview”](https://ephemeral-sandbox.com/architecture)。
5. Ephemeral Sandbox，[“LayerStack Store and Copy-on-Write”](https://ephemeral-sandbox.com/architecture/layerstack)。
6. Ephemeral Sandbox，[“Multi-Agent Coding Workspaces”](https://ephemeral-sandbox.com/multi-agent-coding-workspaces)。
7. Ephemeral AI Lab，[`ephemeral-sandbox` 源代码仓库](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox)。
8. Ephemeral AI Lab，[`exec_command` 操作契约](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/blob/main/crates/sandbox-operations/catalog/src/runtime/command.rs)。
9. Ephemeral AI Lab，[运行时文件操作契约](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/blob/main/crates/sandbox-operations/catalog/src/runtime/file.rs)。
10. Ephemeral AI Lab，[workspace lifecycle 实现](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/tree/main/crates/sandbox-runtime/workspace/src)。
11. Ephemeral AI Lab，[LayerStack 实现](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/tree/main/crates/sandbox-runtime/layerstack/src)。
