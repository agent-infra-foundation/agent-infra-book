# 第三部分 — 重构 Cloudflare Computer：分支存储减少 98.4%，编辑提速 3.18×，多 Agent 安全并行

第二部分结束于第 8 章，并留下了一条原则：让持久状态随时可用，只有当操作确实需要
Linux 时，才为 Linux 执行环境付费。第三部分从**第 9 章**继续，讨论许多 Agent
反复修改这些持久状态时会发生什么：

> <u>**我们能否保留 Durable Object 与 Computer 的执行模型，同时降低增量工作的
> 成本，并让多 Agent 协作更安全？**</u>

为此，我们构建了 Agent Infra Book 的实验原型 **C3**：

```text
C3 = content-addressed storage + content-defined chunking + copy-on-write
       CAS（内容寻址存储）          CDC（内容定义分块）          COW（写时复制）
```

C3 不是 Cloudflare 产品，也不会替代 Durable Objects。它只改变 Durable Object
SQLite 内部应用层文件的表示方式。

<p align="center">
  <img src="../assets/part-iii/c3-overview.png" alt="C3 在 SQLite 支持的 workspace 中组合 CAS、CDC 与 COW" width="40%" />
</p>

```text
第二部分：工作应该在哪里运行？             第三部分：工作应该如何存储？

第 5～8 章                              第 9～13 章
isolate -> 按需启动 container       ->   CAS -> COW -> CDC -> branch -> benchmark
```

## TL;DR

- <u>**存储：**</u> CAS 共享相同字节，COW 让私有编辑保持稀疏，CDC 则在内容偏移后
  重新找到可复用的边界。
- <u>**速度：**</u> 在 10 组配对的完整 Computer 测试中，16 次微小编辑
  **快了 3.18×**，文件头插入**快了 3.81×**；但首次写入 32 MiB 数据
  **慢了 37%**。
- <u>**多 Agent：**</u> 50 个私有 branch 的**完整分支独占内容减少了 98.4%**；
  同一文件上的过期发布不再静默覆盖，而会变成显式冲突。
- **完整链路：** 两个 Agent 分别经过两个 computerd 进程和两个真实 FUSE 挂载，
  最终发布到同一个 SQLite 权威存储。
- **从 FUSE 到 COW：** 两次单字节编辑只保留了 **8 KiB 私有 COW 页面**和
  **8.2 KiB 完整分支独占内容**；实测固定分块 adapter 则需要 **1.00 MiB**。
- <u>**剩余瓶颈：**</u> 同一次冷启动 branch 执行仍在 push 阶段移动 4 MiB、
  在 pull 阶段移动 2 MiB。紧凑的 branch 状态不等于紧凑的同步协议。

```text
                               C3
                    +-----------+-----------+
                    |           |           |
                    v           v           v
                   存储          速度         多 AGENT
                CAS + COW    COW + CDC    branch + publish
                    \           |           /
                     +----------+----------+
                                |
                                v
                     Durable Object SQLite
                         仍是唯一事实源
```

本文会按执行边界为每张 benchmark 表标注证据层级：

| 证据层级 | 含义 |
| --- | --- |
| **engine** | 在本地 workerd 的 Durable Object SQLite 内直接调用存储引擎；不经过请求跳转、computerd 或 FUSE。 |
| **Durable Object request** | 向同一个本地 Durable Object 发送独立的 `fetch()` 请求；包含请求调度和串行化，但不包含 computerd/FUSE。 |
| **full Computer E2E** | 完整经过 Computer push、computerd、真实 FUSE、shell 命令、pull、Durable Object SQLite 与最终验证。 |

---

## 第 9 章 — CAS：一次存储，处处共享

> <u>**存储原则：**</u> **branch 应该引用未变化的内容，而不是复制它。**

### C3 从 Computer 继承了什么？

Computer 已经使用 SHA-256 对 chunk（分块）进行哈希，并只保存一份相同内容。
C3 保留这一层，同时加入不可变 manifest（清单）与 branch 引用：

| 层次 | Computer baseline | C3 扩展 |
| --- | --- | --- |
| 内容 | SHA-256 chunk | 沿用相同的 CAS 规则 |
| 文件身份 | 有序的固定分块 | 不可变的紧凑 manifest |
| 私有工作 | 一个 workspace 视图 | branch 指向基础 manifest |

```text
CAS objects
  hash-A -> bytes A
  hash-B -> bytes B
  hash-C -> bytes C
  hash-X -> Agent A 修改后的 bytes

main manifest M42  -> [hash-A, hash-B, hash-C]
agent-a base       -> M42
agent-b base       -> M42

Agent A 编辑后：
agent-a view       -> [hash-A, hash-X, hash-C]
agent-b view       -> [hash-A, hash-B, hash-C]
main               -> [hash-A, hash-B, hash-C]
```

创建 branch 只是写入 metadata，而不是复制 checkout：

```sql
INSERT INTO branches(branch_id, base_commit, state)
VALUES ('agent-a', 42, 'active');
```

[原型 schema](../benchmarks/cas-cdc-cow/src/engines/cas-cdc-cow.ts)
包含五类职责：

| 表的职责 | 记录内容 |
| --- | --- |
| CAS objects | 以 SHA-256 索引的不可变内容 |
| Manifests | 一个文件版本中有序的 chunk hash 与大小 |
| Main files | 权威 workspace 当前可见的 manifest |
| Branch files | 一个 Agent 的基础 manifest 与私有物化结果 |
| Versions | 绑定到 commit 的历史文件 manifest |

每个紧凑条目由 **32 字节 hash + 4 字节大小**组成：

```text
manifest entry = SHA-256 digest (32 B) + size (4 B)
manifest ID    = SHA-256(file size + encoded entries)
```

实现：[`compact-manifest.ts`](../benchmarks/cas-cdc-cow/src/engines/compact-manifest.ts)。

### 为什么它对多 Agent 很重要？

假设 workspace 为 10 GiB，共有 50 个 Agent：

| Branch 表示方式 | 创建 branch 时大约需要复制的基础数据 |
| --- | ---: |
| 每个 Agent 一份完整 checkout | 500 GiB |
| C3 branch 引用 | 只创建 branch metadata；未变化的 CAS 内容共享 |

> **不变量：** 创建 branch 的成本应随 metadata 增长，而不是随 workspace 大小增长。

### CAS 无法解决所有编辑问题

CAS 只能识别完全相同的内容：

```text
SHA256("abcdef") != SHA256("Xabcdef")
```

```text
只使用 CAS                     C3 组合

完全重复 -> 共享                CAS -> 共享未变化字节
边界偏移 -> 新内容              CDC -> 找回后续边界
私有编辑 -> 新视图              COW -> 只保留被触碰页面
```

> **本章结论：** CAS 为所有 branch 提供一个共享、不可变的基础层。它消除了完整
> workspace 副本，但只做精确哈希并不能让小编辑变得便宜。

---

## 第 10 章 — COW：只写发生变化的部分

> <u>**修改原则：**</u> **私有工作的空间成本应该与编辑量成正比，而不是与文件
> 大小成正比。**

### 什么是私有 COW branch？

C3 把权威文件视为不可变基础层，并把 Agent 的等长覆盖写记录为私有的
**4 KiB COW 页面**。

```text
权威文件
[ page 0 ][ page 1 ][ page 2 ][ page 3 ][ page 4 ]
                         |
                    Agent A 编辑 10 B
                         |
                         v
agent-a branch pages
                      [ private page 2 ]

Agent A 读取：base pages 0,1 + private page 2 + base pages 3,4
Main 读取：   base pages 0,1,2,3,4
```

<p align="center">
  <img src="../assets/part-iii/shared-base-cow-branches.png" alt="多个 Agent 共享同一个不可变 base，并分别保存私有 COW 修改" width="40%" />
</p>

对同一页面的重复写入会替换同一条 SQLite page row：

```ts
if (equalLengthOverwrite && editBytes <= 64 * KiB) {
  for (const page of touchedPages) {
    branchPages.upsert(branchId, path, page.index, page.bytes);
  }
}
```

证据：[`engines.test.ts`](../benchmarks/cas-cdc-cow/src/tests/engines.test.ts)
验证了同一页面上的五次编辑只保留一条 4 KiB row，跨页面编辑则保留两条。

### Agent 读取时会发生什么？

C3 按固定覆盖顺序读取 branch：

```ts
function readBranch(branch, path) {
  let bytes = readManifest(branch.base(path));
  bytes = overlayPages(bytes, branch.pages(path));
  bytes = applyOrderedPatches(bytes, branch.patches(path));
  return bytes;
}
```

其他 Agent 看不到这些私有页面。只有执行 publish（发布）时，main workspace
才会发生变化。

不要把一个 COW 组成部分误当成完整存储成本：

```text
完整分支独占内容
  = 私有 COW 页面
  + 有序 patch 字节
  + 仅属于 branch 的 CAS objects
  + 仅属于 branch 的 manifest 字节

SQLite 增长量 = 单独测量的物理指标，还包含 rows、indexes、pages 与分配开销。
```

### page-level COW 能节省多少空间？

在 50 Agent 测试中，每个 Agent 都对自己的 256 KiB 私有文件修改一个字节：

**证据层级：Durable Object request。**

| publish 前的 branch 存储 | 固定分块 branch | C3 COW branch |
| --- | ---: | ---: |
| 私有 COW 页面 payload | 0 KiB | **200 KiB** |
| 完整分支独占内容 | 12,804 KiB | **200 KiB** |
| branch 活跃期间的 SQLite 增长量 | 12,880 KiB | **232 KiB** |
| 每个 Agent 的完整独占内容 | 256.1 KiB | **4 KiB** |
| 完整独占内容降幅 | — | **98.4%** |

测试使用高熵文件，避免无关内容因偶然相同而被去重。完整结果见
[`multi-agent-latest.md`](../benchmarks/cas-cdc-cow/results/multi-agent-latest.md)。

### COW 在哪里不再有效？

C3 根据写入形态选择表示方式：

```text
                           EDIT
                            |
              +-------------+-------------+
              |                           |
         是否等长？                       否
              |                           |
      +-------+-------+               插入/删除
      |               |                   |
   <=64 KiB         更大写入           有序 patch
      |               |                   |
  4 KiB COW       CDC/CAS          patch 是否过多？
    pages           物化                  |
                                      全量 fallback
```

| 操作 | C3 私有表示方式 |
| --- | --- |
| 小范围覆盖写 | 对 4 KiB page 执行 UPSERT |
| 重复覆盖同一页面 | 替换同一条 branch row |
| 小范围插入或删除 | 有序结构性 patch |
| 大于 512 KiB 的替换 | 直接物化到 CDC/CAS |
| 大量结构性 patch | 回退到规范化的全文件路径 |

分布广泛的编辑和全量重写仍可能接近 O(file size)。fallback 的目标是保证正确性，
而不是承诺常数时间写入。

> **本章结论：** COW 让私有覆盖写变得便宜且彼此隔离。它减少 branch 存储与
> 编辑工作量，同时通过明确的 fallback 保证结构性修改和大规模修改的正确性。

---

## 第 11 章 — CDC：让小改动保持小

> <u>**边界原则：**</u> **chunk 边界应该尽可能跟随内容，使局部插入或删除之后
> 仍能重新连接到原有内容。**

### 为什么固定位置很脆弱？

第一部分已经测量了 Computer 的固定 512 KiB chunk。一次微小覆盖写通常只会改变
一个 chunk，这可以接受。但文件头插入不同，因为此后的每个固定偏移都会移动：

```text
插入前
|---- A ----|---- B ----|---- C ----|---- D ----|

在文件头插入 10 bytes
|---- A' ---|---- B' ---|---- C' ---|---- D' ---|...

固定边界：此后的每个 chunk 都可能包含不同的 bytes
```

CDC 根据内容而不是绝对偏移选择边界：

```text
插入前
|-- A --|--- B ---|---- C ----|-- D --|

文件头插入后
| changed prefix |--- B ---|---- C ----|-- D --|
                       ^ 在这里重新同步边界
```

第一个重新匹配的熟悉边界，会把新前缀重新连接到旧 CAS hash。

<p align="center">
  <img src="../assets/part-iii/fixed-vs-cdc.png" alt="固定分块会放大文件头插入，而 CDC 将变化限制在局部" width="40%" />
</p>

### 原型使用什么算法？

C3 使用紧凑的 FastCDC 风格 rolling Gear fingerprint，并采用以下参数：

| 参数 | 数值 | 目的 |
| --- | ---: | --- |
| 最小 chunk | 32 KiB | 避免产生过多微小 objects |
| 目标平均值 | 128 KiB | 相比固定 512 KiB chunk，提高编辑局部性 |
| 最大 chunk | 512 KiB | 限制 object 大小 |

核心循环有意保持精简：

```ts
while (offset < bytes.length) {
  const end = findContentBoundary(bytes, offset, {
    min: 32 * KiB,
    average: 128 * KiB,
    max: 512 * KiB,
  });

  emit(sha256(bytes.slice(offset, end)));
  offset = end;
}
```

代码：[`fastcdc.ts`](../benchmarks/cas-cdc-cow/src/engines/fastcdc.ts)。

### 为什么不在每次编辑后扫描整个文件？

全文件 CDC 扫描可以提高存储复用率，但也可能让一次单字节编辑变成 O(file size)。
C3 从 dirty region（脏区域）附近开始扫描，并逐步扩大范围，直到新的 chunk 序列
重新连接到未变化的旧内容：

```text
旧 manifest
[ A ][ B ][ C ][ D ][ E ][ F ][ G ]
              ^ 编辑位置

局部 publish 窗口
        [ B ][ C' ][ D' ][ E ]
                           ^ 找到旧边界

新 manifest
[ A ][ B ][ C' ][ D' ][ E ][ F ][ G ]
  复用             新建       复用
```

```ts
function publishLocalEdit(oldManifest, dirtyRange) {
  const left = previousBoundary(oldManifest, dirtyRange.start);
  const scanned = rechunkUntilKnownBoundary(left);
  return splice(oldManifest.prefix(left), scanned.newChunks, scanned.oldSuffix);
}
```

在一个 16 MiB 文件上执行 1,000 次单字节覆盖写，分离式 benchmark 测得：

**证据层级：engine。**

| 指标 | 固定分块 baseline | C3 |
| --- | ---: | ---: |
| 私有编辑时间 | 4.02 s | **274 ms** |
| publish 时间 | 1 ms | 124 ms |
| 总时间 | 4.02 s | **398 ms** |
| 总体速度 | — | **快 10.1×** |
| 写入 SQL 的 payload | 497.5 MiB | **19.9 MiB** |

baseline 在编辑阶段支付成本；C3 则把 124 ms 的工作移到 publish 阶段。
比较时必须看总时间。

### CDC 的代价是什么？

完整 Computer benchmark 展示了这项权衡：

**证据层级：full Computer E2E。10 组配对运行的中位数。**

| 首次创建 32 MiB 文件 | Computer baseline | C3 |
| --- | ---: | ---: |
| 完整链路时间 | **1,618.5 ms** | 2,219.0 ms |
| C3 变化 | — | **慢 37%** |

| 工作负载形态 | CDC 判断 |
| --- | --- |
| 创建一次、反复编辑 | 非常适合 |
| 文件头插入或删除 | 非常适合 |
| 写入一次、不再修改 | 首次扫描成本可能无法回收 |
| 完全无关的全量重写 | 几乎无法复用内容 |

> **本章结论：** CDC 能把许多导致偏移变化的修改重新变成局部修改，但需要额外的
> CPU 与 metadata 工作来识别可复用内容。

---

## 第 12 章 — Branch 与 Publish：多 Agent，一个持久主干

> <u>**协调原则：**</u> **Agent 可以独立工作，但 publish 必须经过一个事务性
> 权威存储。**

### 多 Agent 模型是什么？

每个 branch 都记录自己从哪个 main commit 开始。每个变化的文件也记录自己的
基础 manifest。

```text
                         Workspace Durable Object
                           main commit 42
                                |
                    共享的不可变 CAS objects
                                |
             +------------------+------------------+
             |                  |                  |
             v                  v                  v
        agent-a / 42       agent-b / 42       agent-c / 42
          COW pages          COW pages          COW pages
             |                  |                  |
             +------------------+------------------+
                                |
                        事务性 publish
```

```text
创建 branch
     |
     v
  ACTIVE --publish 成功--> MERGED
     |
     +----基础已变化------> CONFLICT --rebase/retry--> ACTIVE
     |
     `----Agent 放弃------> DISCARDED
```

<p align="center">
  <img src="../assets/part-iii/multi-agent-publication-gate.png" alt="独立工作的 Agent 通过同一个事务性 SQLite 权威存储发布" width="40%" />
</p>

### Publish 如何检测冲突？

C3 使用文件级 optimistic check（乐观检查）：

```ts
for (const changedFile of branch.files) {
  if (main.manifest(changedFile.path) !== changedFile.baseManifest) {
    return { outcome: "conflict", path: changedFile.path };
  }
}
```

即使 workspace 的全局 commit 已经前进，只要两个 branch 修改不同文件，它们仍可
分别合并：

```text
两个 Agent 都从 commit 42 开始

Agent A 修改 /src/a.ts  -> publish -> commit 43
Agent B 修改 /src/b.ts  -> publish -> commit 44

两次修改都能保留，因为 commit 43 没有改变 /src/b.ts。
```

如果两个 Agent 修改同一个文件，第二次 publish 就会过期：

```text
Agent A: /src/a.ts base = hash-10 -> publish hash-11
Agent B: /src/a.ts base = hash-10 -> current is hash-11
                                      |
                                      +-> 显式 conflict
```

| 冲突层 | 职责 |
| --- | --- |
| C3 | 检测过期文件 manifest；绝不静默覆盖 |
| Agent/harness | retry、rebase、调用合并工具或请求人工解决 |

### 哪些操作具有原子性？

哈希过程可能包含 `await`，因此 C3 会检查两次基础状态：准备前检查一次，在一个同步
SQLite 事务开始前再检查一次：

```sql
BEGIN;

-- 验证每个变化文件仍然具有预期的基础 manifest
-- 插入缺失的 CAS objects 和新 manifest
-- 追加文件 versions
-- 移动权威文件指针
-- 推进 main commit
-- 删除私有 branch pages
-- 把 branch 标记为 merged

COMMIT;
```

代码：[`publish()`](../benchmarks/cas-cdc-cow/src/engines/cas-cdc-cow.ts)。

publish 使用 operation ID 作为 idempotency key（幂等键）。完全相同的 retry 会返回
已记录的结果；如果另一个 branch 重用该 ID，则会被拒绝。

**证据层级：engine。**

| 恢复场景 | 已验证行为 |
| --- | --- |
| 注入 SQLite 故障后重建 engine | 事务回滚；main 不变；retry 成功 |
| 响应丢失后重建 engine | 相同 operation ID 返回原始 merge 或 conflict，不产生第二次 commit |
| 放弃但仍为 active 的 branch + GC | branch 数据仍可达；无关的 orphan 数据被回收 |
| discard 已放弃 branch + GC | branch 独占 CAS objects 变为不可达并被回收 |
| truncate | 缩短后的文件以精确内容完成 publish |
| rename 失败 + retry | 源路径和目标路径一起回滚；retry 原子完成 |

测试：[`recovery.test.ts`](../benchmarks/cas-cdc-cow/src/tests/recovery.test.ts)。

### 是否测试了真实的 Durable Object 请求？

**证据层级：Durable Object request。**

| 测试边界 | 提交的工作 | 能证明什么 |
| --- | ---: | --- |
| 本地 workerd Durable Object | 50 个 edit + 50 个 publish 请求 | 请求调度、私有状态、冲突与原子 publish |
| 权威存储 | 一个 SQLite owner | Agent 独立准备；被接受的 commit 按顺序写入 |

测试：[`multi-agent-do.test.ts`](../benchmarks/cas-cdc-cow/src/tests/multi-agent-do.test.ts)。

### Branch 模型能否贯穿 Computer 执行链路？

可以。原型现在验证了三个层次：

| 层次 | 状态 |
| --- | --- |
| Durable Object SQLite 内的 C3 branch engine | 已实现，并使用 50 个 Agent 测试 |
| 经过 Computer、computerd、FUSE 与 pull 的 C3 分块 | 已使用一个执行挂载进行实现和 benchmark |
| branch-specific Computer push/shell/pull adapter | **已在 Computer 现有 RPC wire 上实现** |
| 两个同时工作的 branch 独立执行 | **已验证两个 computerd 进程和两个真实 FUSE 挂载** |
| create、rename 与 delete 冲突语义 | **已为普通文件命名空间实现** |

adapter 把 branch identity 保留在 Computer 未修改的 RPC 接口之上：

```text
一个由 Workspace 持有的 Durable Object SQLite
  |
  +-> branch agent-a -> push -> computerd A -> FUSE A -> shell
  |                                      -> pull -> branch agent-a
  |
  +-> branch agent-b -> push -> computerd B -> FUSE B -> shell
                                         -> pull -> branch agent-b

publish(agent-a) -> merge or conflict
publish(agent-b) -> merge or conflict
```

```ts
async function runBranch(branchId, command, computer) {
  const cursor = await computer.push(branchView(branchId), { senderRev: 0 });
  await computer.shell.exec(command);          // computerd + FUSE
  const delta = await computer.fetchChanges({ after: cursor });
  applyToPrivateBranch(branchId, delta);
  return publishWithBaseChecks(branchId);
}
```

| 原型边界 | 状态 |
| --- | --- |
| 普通文件 | 已实现 |
| Rename | 带冲突检查的 create + delete |
| Symlink/目录 metadata 合并 | 未实现 |
| Executor pooling、进程终止恢复与 quotas | 尚未达到生产级加固 |

现在可以做出的严谨表述是：

> **C3 是一个支持 branch 的 Cloudflare Computer 可运行原型，已经通过真实
> computerd/FUSE 执行验证；它不是 Cloudflare 的生产版本。**

> **本章结论：** 私有工作可以独立扩展；Durable Object 负责排序 publish；不同文件
> 可以 merge；对同一文件的过期写入会显式失败。

---

## 第 13 章 — Benchmark：存储、速度与多 Agent 执行

两个候选方案都使用 Durable Object SQLite，差别只在应用层文件系统的表示方式。

### 实际比较的是什么？

```text
单 WORKSPACE
  baseline = 固定到指定 commit 的上游 Computer 512 KiB VFS
  C3       = 相同 Computer commit + DOFS C3 patch

两个私有 BRANCH
  baseline = 实测固定 512 KiB branch adapter，last-writer-wins publish
  C3       = 实测 CDC/CAS/COW branch adapter，conflict-aware publish

两项 E2E 比较都经过：
  Durable Object SQLite -> push -> computerd -> FUSE -> shell -> pull -> verify
```

benchmark 明确区分三个证据层级：

| 证据层级 | 能证明什么 |
| --- | --- |
| **engine** | COW branch、CDC publish、冲突行为、GC 与精确 SQL payload |
| **Durable Object request** | 独立 Agent 请求由同一个本地 Durable Object 串行化，并 publish 到同一个 SQLite 权威存储 |
| **full Computer E2E** | 结果经过 push、computerd、真实 FUSE、shell、pull、publish 和最终验证后仍然成立 |

完整链路如下：

```text
Workspace DO SQLite
  -> push
  -> computerd
  -> 通过 FUSE 挂载的 Linux workspace
  -> command
  -> pull
  -> Workspace DO SQLite
  -> 权威结果验证
```

受控变量包括：固定的 Computer commit、Worker、RPC、FUSE daemon、命令和验证流程。
C3 同时 patch Workspace 端和 computerd 端的 DOFS。

### 存储：C3 能否减少写放大？

聚合存储工作负载从一个 64 MiB 文件开始，执行 32 个持久 checkpoint：24 次微小
覆盖写、7 次文件头插入和 1 次全量重写。

**证据层级：engine。**

| 聚合指标 | 固定分块 baseline | C3 | 结果 |
| --- | ---: | ---: | ---: |
| 写入 SQL 的 payload | 524.0 MiB | 69.2 MiB | **减少 86.8%** |
| 写放大 | 8.19× | 1.08× | **降低 7.57×** |
| SQLite 数据库增长量 | 526.0 MiB | 70.1 MiB | **减少 86.7%** |
| GC 前的 orphan payload | 524.0 MiB | 69.1 MiB | **减少 86.8%** |
| GC 后保留内容 | 64.0 MiB | 64.0 MiB | 当前 workspace 相同 |

```text
相同最终文件：64 MiB

baseline 写入 524.0 MiB  [################################]
C3 写入       69.2 MiB   [####]
```

完整 Computer pipeline 在一个 32 MiB 文件上呈现相同趋势：

**证据层级：full Computer E2E。10 组配对运行的中位数 [Q1, Q3]。**

| 完整链路存储 | Computer baseline | C3 | 降幅 |
| --- | ---: | ---: | ---: |
| 16 次微小编辑后的 BLOB 增长 | 8.00 MiB [8.00, 8.00] | 3.20 MiB [3.20, 3.20] | **60.0%** |
| 文件头插入后的 BLOB 增长 | 32.00 MiB [32.00, 32.00] | 0.19 MiB [0.19, 0.19] | **99.4%** |
| 最终 SQLite 数据库 | 72.32 MiB [72.32, 72.32] | 35.89 MiB [35.89, 35.89] | **50.4%** |

### 速度：数据更少是否也意味着速度更快？

对于 64 MiB 聚合存储工作负载：

**证据层级：engine。**

| 操作 | 固定分块 baseline | C3 | 结果 |
| --- | ---: | ---: | ---: |
| 32 个 edit-and-publish checkpoint | 3.39 s | 663 ms | **快 5.11×** |
| Garbage collection | 860 ms | 261 ms | **快 3.30×** |

对于完整 Computer 链路：

**证据层级：full Computer E2E。10 组配对运行的中位数 [Q1, Q3]。**

| 操作 | Computer baseline | C3 | 结果 |
| --- | ---: | ---: | ---: |
| 首次创建 32 MiB 文件 | **1,618.5 ms [1,609.3, 1,630.8]** | 2,219.0 ms [2,169.0, 2,276.0] | C3 **慢 37%** |
| 16 次持久微小编辑 | 5,122.0 ms [5,100.5, 5,159.0] | 1,608.5 ms [1,569.5, 1,615.5] | C3 **快 3.18×** |
| 10-byte 文件头插入 | 1,638.0 ms [1,628.3, 1,682.8] | 430.0 ms [424.3, 443.8] | C3 **快 3.81×** |
| 完整读取与同步区间 | 207.0 ms [202.3, 208.5] | 155.5 ms [154.0, 157.8] | C3 **快 1.33×** |

应根据工作负载形态选择方案，而不是寻找一个适用于所有场景的赢家：

```text
只写一次、很少编辑       -> baseline 可能更合适
大文件、反复编辑          -> C3 更有吸引力
文件头插入/删除           -> CDC 优势明显
完全无关的全量重写       -> 几乎无法复用内容
```

### 多 Agent：branch 能否节省空间并避免更新丢失？

多 Agent benchmark 向同一个本地 Durable Object 分别发送 50 个 branch 的请求。
第一组测试中，每个 Agent 修改一个不同的 256 KiB 文件：

**证据层级：Durable Object request。**

| 50 个修改不同文件的 Agent | 固定分块 branch | C3 branch | 结果 |
| --- | ---: | ---: | --- |
| 私有 COW 页面 payload | 0 KiB | 200 KiB | C3 使用 page overlay；固定分块不使用 COW pages |
| 完整分支独占内容 | 12,804 KiB | 200 KiB | **减少 98.4%** |
| branch 活跃期间的 SQLite 增长量 | 12,880 KiB | 232 KiB | **减少 98.2%** |
| Edit requests | 253 ms | 138 ms | C3 **快 1.83×** |
| Publish requests | **139 ms** | 259 ms | C3 publish 较慢 |
| Edit + publish 总时间 | **392 ms** | 397 ms | 基本相同 |
| 正确的最终文件 | 50/50 | 50/50 | 所有互不相交的编辑均被保留 |

C3 用更慢的规范化 publish 换取了 98.4% 的私有存储降幅；总请求时间仍然接近。

下一组测试让 50 个 Agent 修改同一文件的同一个字节：

**证据层级：Durable Object request。**

| 同一文件上的竞争 | 固定分块 branch | C3 branch |
| --- | ---: | ---: |
| 报告为 merged 的 publish | 50 | **1** |
| 显式 conflicts | 0 | **49** |
| 静默丢失的更新 | 49 | **0** |
| 私有 COW 页面 payload | 0 KiB | **200 KiB** |
| 完整分支独占内容 | 12,548 KiB | **200 KiB** |
| branch 活跃期间的 SQLite 增长量 | 12,588 KiB | **232 KiB** |

baseline 报告 50 次 merge，但其中 49 个值最终消失。C3 则报告一个 winner 和
49 个过期 branch：

> <u>**一个会静默丢失工作的快速多 Agent workspace，并不是正确的多 Agent
> workspace。**</u>

### 多 Agent E2E：branch 能否贯穿 shell 与 FUSE？

50 Agent 测试隔离了 Durable Object publish。第二组测试通过两个独立 Computer
runtime 补上执行链路：

```text
私有 branch A -> push -> computerd A -> FUSE A -> shell -> pull --+
                                                                  |
私有 branch B -> push -> computerd B -> FUSE B -> shell -> pull --+
                                                                  v
                                                    一个 SQLite publish 权威存储
```

<p align="center">
  <img src="../assets/part-iii/two-fuse-workspaces.png" alt="两个隔离的 FUSE workspace 通过同一个 SQLite 权威存储执行 push 与 pull" width="40%" />
</p>

比较共执行 10 组完整配对运行。每组的先后顺序由已记录的随机种子决定，延迟使用
中位数 [Q1, Q3] 报告。

**证据层级：full Computer E2E。**

| Benchmark 设置 | 数值 |
| --- | --- |
| 持久权威存储 | 1 个本地 workerd Durable Object SQLite |
| 并发 Agent | 2 个私有 branch |
| 原生执行 | 2 个 computerd 进程 + 2 个真实 FUSE 挂载 |
| 稀疏工作负载 | 两个 1 MiB 伪随机文件；每个 Agent 修改 1 byte |
| 排除项 | 进程启动、初始 seed 和最终验证 |

#### 存储与同步

**证据层级：full Computer E2E。两列都经过相同的 two-mount 工作负载实测。**

| 指标 | 固定分块 adapter | C3 | 解读 |
| --- | ---: | ---: | --- |
| 逻辑变化量 | 2 bytes | 2 bytes | 每个 Agent 一个字节 |
| 私有 COW 页面 payload | 0 KiB | **8 KiB** | 每个 C3 Agent 一个 4 KiB COW page |
| 完整分支独占内容 | 1.00 MiB | **8.2 KiB** | **减少 99.2%** |
| branch 活跃期间的 SQLite 增长量 | 1.01 MiB | **0.01 MiB** | **减少 99.2%** |
| 两个 Agent 的 cold push objects | 4.00 MiB | 4.00 MiB | 两个独立执行镜像 |
| 两个 Agent pull 的 objects | 2.00 MiB | 2.00 MiB | 每个变化文件都被重新构建 |
| 四类冲突中的静默更新丢失 | **4** | **0** | C3 拒绝过期 publish |

存储结果非常突出，但也暴露了下一个瓶颈。C3 只保留 8 KiB COW pages 与 8.2 KiB
完整分支独占内容，cold execution round 却仍通过 push 和 pull 移动 6 MiB。
**branch 存储已不再是主要问题，branch 同步才是。**

#### 端到端 wall time

**证据层级：full Computer E2E。10 组配对运行的中位数 [Q1, Q3]。**

| 阶段 | 固定分块 adapter | C3 |
| --- | ---: | ---: |
| Push 两个 branch view | 192.5 ms [192.0, 196.8] | **187.5 ms [184.0, 188.8]** |
| 运行两个 FUSE shell 命令 | **30.0 ms [29.3, 31.0]** | 35.0 ms [34.0, 36.0] |
| Pull 两个执行 delta | 95.0 ms [89.8, 97.8] | **81.5 ms [79.3, 87.8]** |
| Publish 两个 branch | **1.0 ms [0.0, 1.0]** | 6.0 ms [6.0, 6.0] |
| **Push -> shell -> pull -> publish** | 323.0 ms [317.3, 327.5] | **316.5 ms [310.3, 319.8]** |

push、shell 与 pull 会在两个 executor 之间并发运行，Durable Object 则负责排序
两次 publish。每次修改都来自对 FUSE 发出的 shell 命令；adapter 从 pull 回来的
bytes 中推导出稀疏等长区间，并将其保存为 COW pages。

```text
C3 branch round 中位数：316.5 ms

push       187.5 ms  [###################]
shell       35.0 ms  [####               ]
pull        81.5 ms  [########           ]
publish      6.0 ms  [#                  ]
```

**证据层级：full Computer E2E。**

| 两 Agent 冲突场景 | Agent A | Agent B | 已验证行为 |
| --- | --- | --- | --- |
| 互不相交的 edit + create/delete/rename | merged | merged | 两个 branch 都被保留 |
| 同一文件写入 | merged | conflict | 过期 writer 被拒绝 |
| 同一路径 create | merged | conflict | 路径碰撞被拒绝 |
| Delete 与 edit 冲突 | merged | conflict | 已删除的基础文件不会被恢复 |
| Rename 与 edit 冲突 | merged | conflict | 对旧路径的过期编辑被拒绝 |

这是本地架构证据，不是对生产环境 throughput 或 latency distribution 的承诺。
详情见
[`机器可读结果`](../benchmarks/cas-cdc-cow/e2e/results/branches-latest.json)
与精简的
[`展示表`](../benchmarks/cas-cdc-cow/e2e/results/branches-presentation.md)。

### 我们可以得出什么结论，又不能得出什么结论？

| 有证据支持的结论 | 没有证据支持的结论 |
| --- | --- |
| CDC/CAS/COW 可以显著降低增量存储写放大。 | C3 在每种工作负载上都更快。 |
| 优势经过完整 Computer/FUSE 同步链路后仍然存在。 | two-mount 验证足以证明生产级 executor throughput。 |
| 私有 COW branch 可以远小于固定分块私有副本。 | 原型已经达到生产可用状态。 |
| 文件级乐观检查可以避免同一文件被静默覆盖。 | C3 能自动合并发生冲突的源代码。 |
| 两个 branch-specific Computer session 可以正确 merge 或 conflict。 | 每一种 POSIX namespace 操作都已经具备合并策略。 |
| 小型私有状态不代表网络传输量也小。 | 8 KiB branch 结果意味着 push/pull 只传输了 8 KiB。 |
| Durable Object SQLite 适合充当事务性 publish 权威存储。 | C3 修改了 Cloudflare 底层 Durable Object storage engine。 |

当前原型已经测试事务性 publish 故障/retry、idempotency、放弃 branch 的 GC、
truncate 与 rename 回滚。投入生产前，仍需要补充 in-flight push/pull 期间的突然
进程终止恢复、symlink 与目录 metadata 合并语义、executor pooling、迁移支持、
quotas、observability 与生产规模 GC。

---

## 应该记住什么？

```text
                         一个持久权威存储
                                  |
                 +----------------+----------------+
                 |                |                |
                存储              速度             多 AGENT
           CAS + COW + CDC      局部更新       branch + publish
                 |                |                |
              更少数据          更少工作          不静默丢失
                 +----------------+----------------+
                                  |
                         下一步：降低同步成本
```

| 问题 | 答案 |
| --- | --- |
| 什么仍是唯一事实源？ | 一个 Durable Object SQLite 数据库 |
| CAS 节省什么？ | 完全相同的重复内容 |
| COW 节省什么？ | 私有稀疏编辑 |
| CDC 节省什么？ | 插入/删除后发生偏移的内容 |
| 什么让它支持多 Agent？ | 私有 branch + optimistic publish |
| 什么仍然昂贵？ | cold branch 的 push/pull 同步 |
| C3 是否已达到生产可用？ | 没有；它是一个有实验证据支持的原型 |

## 运行、检查与验证

```powershell
# 存储、编辑规模、高容量和 50 Agent publish
cd cloudflare/computer/benchmarks/cas-cdc-cow
npm.cmd run run
npm.cmd run run:scale
npm.cmd run run:volume
npm.cmd run run:agents

# 完整 Computer/FUSE 和 two-branch 执行
cd e2e
npm.cmd run prepare
npm.cmd run smoke
npm.cmd run benchmark
npm.cmd run branches
npm.cmd run paired:volume
npm.cmd run paired:branches
```

| 证据 | 链接 |
| --- | --- |
| 上游 baseline | [Computer commit `76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b) |
| Storage engine | [`cas-cdc-cow.ts`](../benchmarks/cas-cdc-cow/src/engines/cas-cdc-cow.ts) |
| CDC algorithm | [`fastcdc.ts`](../benchmarks/cas-cdc-cow/src/engines/fastcdc.ts) |
| Branch tests | [`multi-agent-do.test.ts`](../benchmarks/cas-cdc-cow/src/tests/multi-agent-do.test.ts)、[`engines.test.ts`](../benchmarks/cas-cdc-cow/src/tests/engines.test.ts) 与 [`recovery.test.ts`](../benchmarks/cas-cdc-cow/src/tests/recovery.test.ts) |
| Computer adapter | [`branch-computer.ts`](../benchmarks/cas-cdc-cow/e2e/template/branch-computer.ts) |
| Storage result | [`volume-latest.md`](../benchmarks/cas-cdc-cow/results/volume-latest.md) |
| 配对完整链路结果 | [`paired-volume-latest.md`](../benchmarks/cas-cdc-cow/e2e/results/paired-volume-latest.md) |
| 配对 branch 结果 | [`paired-branches-latest.md`](../benchmarks/cas-cdc-cow/e2e/results/paired-branches-latest.md) |
| Branch 正确性展示 | [`branches-presentation.md`](../benchmarks/cas-cdc-cow/e2e/results/branches-presentation.md) |

这项独立实验不是 Cloudflare 官方发布内容。
