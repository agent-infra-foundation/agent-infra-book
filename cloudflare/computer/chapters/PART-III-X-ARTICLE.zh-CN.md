# 重构 Cloudflare Computer：分支存储减少 98.4%，编辑提速 3.18×，多 Agent 安全并行

**如果一个 Agent 只改 1 byte，系统是否应该重新保存 512 KiB？如果 50 个 Agent
同时工作，是否应该复制 50 份 workspace？**

Cloudflare Computer 已经解决了一个重要问题：把持久文件保存在 Durable Object
SQLite 中，需要 Linux 时再通过 `computerd` 和 FUSE 执行命令。

但当文件越来越大、checkpoint 越来越频繁、写入者越来越多时，固定分块与单一
workspace 视图会遇到新的压力。

我们因此构建了一个实验原型 **C3**，尝试在不改变 Durable Object SQLite 这一权威
存储的前提下，重做 Computer 的应用层文件表示：

```text
C3 = CAS + CDC + COW
```

- **CAS**：相同内容只保存一次
- **CDC**：内容移动后仍能找到旧分块
- **COW**：私有编辑只保存被修改的页面
- **Branch + Publish**：Agent 独立工作，统一提交

这不是 Cloudflare 官方产品，也没有修改 Durable Objects 的底层存储引擎。它是一个
可以运行、测试和复现的研究原型。

## TL;DR

- **分支存储减少 98.4%：** 50 个 Agent 各修改一个 256 KiB 文件中的 1 byte，
  完整分支独占内容从 12,804 KiB 降至 200 KiB。
- **微小编辑提速 3.18×：** 在 10 组完整 Computer/FUSE 配对测试中，16 次持久
  微小编辑从 5,122 ms 降至 1,608.5 ms。
- **文件头插入提速 3.81×：** 10-byte front insertion 从 1,638 ms 降至 430 ms。
- **不再静默覆盖：** 50 个 Agent 竞争同一文件时，C3 接受 1 次 publish，并明确
  返回 49 次 conflict；baseline 则静默丢失 49 个更新。
- **代价同样真实：** 首次创建 32 MiB 文件时，C3 因 CDC 和 metadata 工作慢 37%。
- **下一瓶颈是同步：** branch 只占 8.2 KiB，不代表 cold push/pull 也只传 8.2 KiB。

完整书稿、代码和结果均已发布在
[Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/computer)。

---

## 问题不是“能不能保存文件”，而是“每次修改要保存多少”

Cloudflare Computer 使用固定 **512 KiB chunk**、SHA-256 哈希和内容去重。对于普通
覆盖写，这个设计简单而有效：修改一个位置，通常只替换一个 chunk。

问题出现在两类工作负载：

1. **高频小编辑**：1 byte 的私有修改仍可能产生一个 512 KiB 新 chunk。
2. **文件头插入**：所有固定偏移向后移动，后续 chunk 可能全部改变。

多 Agent 又放大了这一问题。若每个 Agent 都物化一份完整工作区，空间成本会接近：

```text
workspace × agent 数量
```

对于 10 GiB workspace 和 50 个 Agent，概念上的完整副本规模就是 500 GiB。

我们想要的模型不同：

```text
共享不可变内容
  + 每个 Agent 的少量私有变化
  + 一个事务性 publish 权威存储
```

### 先把系统边界说清楚

这里讨论的不是 Cloudflare 如何实现 Durable Objects 的底层分布式存储。C3 改动的
位置，与 Computer 自己的 VFS 相同：都位于应用通过 `ctx.storage.sql` 创建的 SQLite
表中。

```text
Cloudflare Computer / C3
          |
          v
Durable Objects SQLite API
          |
          v
Cloudflare 托管的底层存储
```

因此，本文的数字是在比较两种**应用层文件表示**：

- baseline：Computer 的固定 512 KiB chunk 与 manifest
- C3：CAS objects、CDC manifest、COW pages 与 branch metadata

Durable Object 的身份、请求串行化和 SQLite 事务能力没有被替换。C3 利用这些能力，
但不把自己的表现描述成 Durable Objects 平台本身的表现。

<p align="center">
  <img src="../assets/part-iii/c3-overview.png" alt="C3 使用 CAS、CDC 与 COW 重构 SQLite workspace" width="40%" />
</p>

---

## 第一步：CAS 让所有 Agent 共享同一个基础层

CAS（content-addressed storage）以内容哈希作为 object 身份：

```text
hash-A -> bytes A
hash-B -> bytes B
hash-X -> Agent A 的新内容
```

main 和所有 branch 引用相同的不可变 objects：

```text
main    -> [A, B, C]
agent-a -> [A, X, C]
agent-b -> [A, B, C]
```

创建 branch 不复制文件，只写少量 metadata：

```sql
INSERT INTO branches
  (branch_id, base_commit, state)
VALUES
  ('agent-a', 42, 'active');
```

因此 branch 创建成本与 metadata 数量相关，而不直接与 workspace 大小相关。

但 CAS 只能识别**完全相同**的内容：

```text
SHA256("abcdef")
  !=
SHA256("Xabcdef")
```

只靠 CAS，还不足以让微小编辑变得便宜。

实现入口：
[`cas-cdc-cow.ts`](https://github.com/agent-infra-foundation/agent-infra-book/blob/30f0a01fe5e8878140a3ffbcd5c07b1245155749/cloudflare/computer/benchmarks/cas-cdc-cow/src/engines/cas-cdc-cow.ts)。

---

## 第二步：COW 让 1 byte 编辑只产生一个 4 KiB 页面

C3 把 main 文件视为不可变基础层。Agent 对文件执行小范围等长覆盖时，只保存被触碰
的 **4 KiB COW page**。

```text
BASE
[0][1][2][3][4]
       |
       +-- Agent A 修改 10 B

agent-a
[base][base][private][base][base]
```

同一 Agent 反复修改同一页面时，SQLite 只替换同一条 page row，而不会不断追加整个
文件版本。

<p align="center">
  <img src="../assets/part-iii/shared-base-cow-branches.png" alt="多个 Agent 共享 BASE，只保存各自的 COW 页面" width="40%" />
</p>

50 Agent 实验中，每个 Agent 修改一个独立 256 KiB 文件中的 1 byte：

| 分支存储 | baseline → C3 | 变化 |
| --- | ---: | ---: |
| 完整独占内容 | 12,804 → 200 KiB | **−98.4%** |
| SQLite 增长 | 12,880 → 232 KiB | **−98.2%** |
| 每 Agent 独占内容 | 256.1 → 4 KiB | **约 1/64** |

这里的“完整独占内容”不仅计算 COW pages，也计算 branch-only CAS objects、manifest
和结构性 patch。它不是只挑一个最好看的内部指标。

[查看 50 Agent 完整结果](https://github.com/agent-infra-foundation/agent-infra-book/blob/30f0a01fe5e8878140a3ffbcd5c07b1245155749/cloudflare/computer/benchmarks/cas-cdc-cow/results/multi-agent-latest.md)。

### COW 读取与 fallback

读取 branch 时，C3 先读取 base manifest，再叠加私有页面和按顺序记录的结构性
patch：

```text
branch view
  = base bytes
  + private pages
  + ordered patches
```

这意味着其他 Agent 和 main 都看不到尚未 publish 的修改。隔离来自 branch identity，
而不是复制完整文件。

COW 也不是每种修改的万能答案：

| 修改形态 | 私有表示 |
| --- | --- |
| 小范围等长覆盖 | 4 KiB COW pages |
| 插入或删除 | ordered patch |
| 大范围替换 | CDC/CAS 物化 |
| patch 过多 | 全文件 fallback |

分布非常广的修改和完整重写仍可能接近 O(file size)。fallback 的目标是让结果保持
正确并限制 metadata 膨胀，而不是承诺任何写入都能在常数时间完成。

---

## 第三步：CDC 让文件头插入不再重写后续所有分块

固定分块依赖绝对偏移：

```text
修改前  [ A ][ B ][ C ][ D ]
头部插入后
        [A'][B'][C'][D']...
```

CDC（content-defined chunking）根据内容决定边界：

```text
修改前  [ A ][ B ][ C ][ D ]
头部插入后
        [新前缀][ B ][ C ][ D ]
                 ^ 重新同步
```

<p align="center">
  <img src="../assets/part-iii/fixed-vs-cdc.png" alt="固定分块放大文件头插入，CDC 在内容中重新同步" width="40%" />
</p>

C3 使用 FastCDC 风格的 rolling Gear fingerprint：

| Chunk 参数 | 数值 |
| --- | ---: |
| 最小 | 32 KiB |
| 目标平均 | 128 KiB |
| 最大 | 512 KiB |

为了避免每次 1 byte 编辑都扫描整个大文件，C3 从 dirty region 附近开始重新分块，
找到旧边界后就重新连接原 manifest：

```text
旧：[A][B][C][D][E][F]
          ^ 修改

新：[A][B][C'][D'][E][F]
    复用    新建    复用
```

这让 CDC 的工作范围尽量跟随变化区域，而不是默认变成 O(file size)。

[查看 FastCDC 实现](https://github.com/agent-infra-foundation/agent-infra-book/blob/30f0a01fe5e8878140a3ffbcd5c07b1245155749/cloudflare/computer/benchmarks/cas-cdc-cow/src/engines/fastcdc.ts)。

### CDC 把成本从哪里移到了哪里？

固定分块的优势是便宜：根据偏移就能找到 chunk，不需要扫描内容。CDC 则需要计算
rolling fingerprint、维护更多 manifest entries，并在 publish 时寻找旧边界。

因此，C3 不是消灭工作，而是改变工作发生的位置：

```text
baseline
小编辑 -> 立刻复制固定 chunk

C3
小编辑 -> 写入稀疏 page
publish -> 局部 CDC + manifest 更新
```

在 16 MiB 文件上进行 1,000 次单字节覆盖的 engine 测试中，baseline 总计约
4.02 s；C3 私有编辑约 274 ms、publish 约 124 ms，总计约 398 ms，快 10.1×。
但如果文件只写入一次，从不再修改，首次 CDC 扫描的成本可能永远无法回收。

这也是为什么完整 E2E 结果必须同时展示首次写入变慢和后续编辑变快，而不能只挑
最有利的数据。

---

## 第四步：Branch + Publish 让多 Agent 并行，但不静默覆盖

每个 branch 记录两个基础事实：

- 从哪个 main commit 开始
- 每个修改文件当时指向哪个 manifest

Agent 可以在私有 branch 中并行编辑。最终 publish 仍由一个 Durable Object SQLite
事务排序：

```text
agent-a --private work--+
                        |
agent-b --private work--+--> publish
                        |      |
agent-c --private work--+      v
                         SQLite main
```

<p align="center">
  <img src="../assets/part-iii/multi-agent-publication-gate.png" alt="多个 Agent 独立工作，通过一个 SQLite 事务权威存储发布" width="40%" />
</p>

publish 前执行文件级 optimistic check：

```ts
if (mainHash !== branch.baseHash) {
  return "conflict";
}
```

- 修改不同文件：两次 publish 都可以成功
- 修改同一文件：第一个成功，第二个得到 conflict
- create、delete、rename：作为同一 namespace 事务检查
- 相同 operation ID 重试：返回原结果，不产生第二个 commit

50 个 Agent 修改同一文件时：

| 结果 | baseline | C3 |
| --- | ---: | ---: |
| 报告 merged | 50 | 1 |
| 显式 conflict | 0 | 49 |
| 静默丢失更新 | **49** | **0** |

baseline 看起来“全部成功”，但最后只能留下一个值。C3 的 49 个 conflict 不是失败的
并发设计，而是避免 silent data loss 的正确边界。

> **一个会静默丢失工作的快速 workspace，不是安全的多 Agent workspace。**

### Publish 为什么必须是一个事务？

计算 hash 的过程可以发生在事务外，但真正改变 main 时，以下步骤必须一起成功或一起
回滚：

```text
检查 base manifest
  -> 写入缺失 objects
  -> 创建新 manifest
  -> 移动 main 指针
  -> 推进 commit
  -> 标记 branch merged
```

如果其中一步失败，main 不能处于“指针已移动、version 尚未记录”之类的中间状态。
C3 在同步 SQLite 事务开始前再次检查 base，并用 operation ID 记录 publish 结果。

这解决了两个常见问题：

- **并发变化：** hash 计算期间 main 已前进，第二次检查返回 conflict。
- **响应丢失：** commit 已成功但调用方没收到响应，相同 operation ID 可以安全重试。

故障注入测试还覆盖了事务回滚、响应丢失后的幂等重试、abandoned branch GC、
truncate 和 rename 回滚。

[查看恢复与幂等测试](https://github.com/agent-infra-foundation/agent-infra-book/blob/30f0a01fe5e8878140a3ffbcd5c07b1245155749/cloudflare/computer/benchmarks/cas-cdc-cow/src/tests/recovery.test.ts)。

---

## 最重要的结果：完整 Computer/FUSE 链路仍然成立

只测 SQLite engine 不足以证明对 Cloudflare Computer 有帮助。最终测试让 baseline
和 C3 都经过相同链路：

```text
Durable Object SQLite
  -> push
  -> computerd + FUSE
  -> shell
  -> pull
  -> SQLite + verify
```

比较固定在同一个
[Cloudflare Computer commit `76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b)，
并执行 10 组随机顺序的配对运行。

### 三种证据不能混在一起

本文保留三个测试边界，因为它们回答的问题不同：

| 证据层级 | 回答的问题 |
| --- | --- |
| engine | 算法本身写了多少数据、耗时多久？ |
| DO request | 多个请求能否正确排序和 publish？ |
| full E2E | 优势通过 Computer/FUSE 后还存在吗？ |

为了让 full E2E 比较尽量公平，两侧使用相同的 Worker、RPC、`computerd`、FUSE、
shell 命令和最终验证。差异只在 Workspace 与执行侧使用哪一种 DOFS 表示。

每一对试验都会随机决定 baseline 和 C3 的先后顺序，结果报告中位数与四分位区间。
这样不能替代生产环境测试，但可以减少固定顺序、冷缓存和单次偶然抖动带来的偏差。

### 速度

| 完整 E2E 场景 | baseline → C3 | 结果 |
| --- | ---: | ---: |
| 首次创建 32 MiB | 1,618.5 → 2,219 ms | **慢 37%** |
| 16 次微小编辑 | 5,122 → 1,608.5 ms | **快 3.18×** |
| 文件头插入 10 B | 1,638 → 430 ms | **快 3.81×** |
| 完整读取同步 | 207 → 155.5 ms | **快 1.33×** |

### 存储

| 完整 E2E 指标 | baseline → C3 | 变化 |
| --- | ---: | ---: |
| 16 次编辑的 BLOB | 8.00 → 3.20 MiB | **−60.0%** |
| 文件头插入的 BLOB | 32.00 → 0.19 MiB | **−99.4%** |
| 最终 SQLite 大小 | 72.32 → 35.89 MiB | **−50.4%** |

[查看配对测试完整结果](https://github.com/agent-infra-foundation/agent-infra-book/blob/30f0a01fe5e8878140a3ffbcd5c07b1245155749/cloudflare/computer/benchmarks/cas-cdc-cow/e2e/results/paired-volume-latest.md)。

### 为什么第一次写入反而更慢？

首次写入没有历史内容可复用。baseline 只需要按 512 KiB 切分和哈希；C3 还需要
执行 CDC 扫描、编码更细的 manifest，并建立后续增量编辑所需的 metadata。

因此，C3 的收益更像一项投资：

```text
首次写入：多付一次索引成本
后续编辑：减少复制、写入和同步工作
```

如果 workload 是 write-once，baseline 可能更合适。如果大文件会持续被 Agent
修改、checkpoint 和分支，C3 才有机会持续回收首次成本。

---

## 两个 Agent、两个 FUSE mount、一个持久主干

多 Agent E2E 又增加了两个独立执行环境：

```text
branch A -> computerd A -> FUSE A --+
                                      +-> SQLite
branch B -> computerd B -> FUSE B --+
```

每个 Agent 通过真实 shell 修改 1 byte，再将 pull 回来的变化保存为私有 branch，最后
向同一个 SQLite main 执行 publish。

<p align="center">
  <img src="../assets/part-iii/two-fuse-workspaces.png" alt="两个独立 FUSE workspace 通过一个 SQLite 权威存储完成 push、pull 与 publish" width="40%" />
</p>

| Two-branch E2E | baseline → C3 |
| --- | ---: |
| 完整分支独占内容 | 1.00 MiB → **8.2 KiB** |
| SQLite 增长 | 1.01 MiB → **0.01 MiB** |
| 总 wall time | 323.0 → **316.5 ms** |
| 冲突场景静默丢失 | 4 → **0** |

结果同时暴露了一个重要事实：

> **8.2 KiB 的 branch，cold round 仍然移动了 4 MiB push 数据和 2 MiB pull 数据。**

也就是说，C3 已经大幅压缩私有存储，但 Computer 当前的全量物化与同步方式仍可能
成为高并发场景的下一瓶颈。

### 真正走向高并发还缺什么？

存储从 1.00 MiB 降到 8.2 KiB，并不会自动让网络和执行链路也缩小 99%。当前
branch adapter 仍会为 cold executor 构造完整视图，pull 也会返回完整变化文件。

下一阶段最值得做的不是继续缩小 COW page，而是让同步协议理解 branch delta：

```text
今天
branch -> 完整物化 -> push/pull

下一步
branch -> delta negotiation
       -> 缺失 object 传输
       -> sparse pull
```

还需要 executor pooling，避免每个 Agent 都长期绑定独立进程；需要 backpressure 和
quota，避免单个 workspace 的同步风暴占满 Durable Object；也需要 branch TTL 与
增量 GC，及时回收放弃的私有状态。

C3 证明的是“紧凑 branch 可以贯穿真实 Computer 执行”。它没有证明当前同步协议
已经适合无限扩展。

[查看 two-branch 展示结果](https://github.com/agent-infra-foundation/agent-infra-book/blob/30f0a01fe5e8878140a3ffbcd5c07b1245155749/cloudflare/computer/benchmarks/cas-cdc-cow/e2e/results/branches-presentation.md)。

---

## 这次重构真正改变了什么？

| 目标 | C3 的变化 |
| --- | --- |
| 更少存储 | 共享 CAS + 稀疏 COW + CDC 重同步 |
| 更快编辑 | 小编辑不再复制整个固定 chunk |
| 多 Agent | 私有 branch + conflict-aware publish |
| 保留的核心 | Durable Object SQLite 仍是唯一事实源 |

C3 最适合：

- 大文件被反复小幅修改
- checkpoint 非常频繁
- 大量 Agent 从同一个 workspace 开始工作
- 必须明确检测冲突，而不能接受 last-writer-wins

它不保证：

- 所有工作负载都更快
- 自动合并冲突代码
- push/pull 只传输 COW pages
- 已达到 Cloudflare 生产级可靠性
- 已覆盖全部 POSIX metadata 与 namespace 语义

当前实现应被看作**有完整链路证据的原型**。生产化仍需要进程中断恢复、目录与
symlink 合并、executor pooling、quota、migration、observability 和更大规模 GC。

---

## 代码与复现

核心测试命令保持短小：

```powershell
cd cloudflare/computer/benchmarks/cas-cdc-cow
npm.cmd test
npm.cmd run typecheck
```

完整 Computer/FUSE 配对测试：

```powershell
cd e2e
npm.cmd run paired:volume
npm.cmd run paired:branches
```

- [C3 完整原型与 benchmark](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/computer/benchmarks/cas-cdc-cow)
- [完整中文版 Part III](https://github.com/agent-infra-foundation/agent-infra-book/blob/main/cloudflare/computer/chapters/PART-III.zh-CN.md)
- [Computer/FUSE adapter](https://github.com/agent-infra-foundation/agent-infra-book/blob/main/cloudflare/computer/benchmarks/cas-cdc-cow/e2e/template/branch-computer.ts)
- [50 Agent Durable Object 测试](https://github.com/agent-infra-foundation/agent-infra-book/blob/main/cloudflare/computer/benchmarks/cas-cdc-cow/src/tests/multi-agent-do.test.ts)
- [机器可读 E2E 结果](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/computer/benchmarks/cas-cdc-cow/e2e/results)

---

## 继续阅读 Agent Infra Book

本文来自开源项目 [Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book)。
这本系统工程书聚焦编码 Agent 背后的基础设施，包括沙箱、持久工作区与执行架构。

- [Star 并关注 Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book)
- [阅读 Cloudflare Computer 专题](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/computer)
- [阅读 Part I：Cloudflare Durable Objects](https://github.com/agent-infra-foundation/agent-infra-book/blob/main/cloudflare/computer/chapters/PART-I.zh-CN.md)
- [阅读 Part II：如何将 Agent 沙箱成本降低 80%](https://github.com/agent-infra-foundation/agent-infra-book/blob/main/cloudflare/computer/chapters/PART-II-X-ARTICLE.zh-CN.md)

> **如果你正在构建编码 Agent、持久 workspace 或多 Agent 执行系统，欢迎复现、
> 质疑并共同改进这个原型。**

Cloudflare Computer 仍处于 preview 阶段。本文实验在本地 workerd、固定源码版本和
受控工作负载中完成，不代表 Cloudflare 生产环境的 throughput 或 latency 承诺。
