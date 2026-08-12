# Kimi 沙箱 FUSE 文件系统（fuse.portal）深度报告

> 调研日期：2026-08-11 / 2026-08-12
> 调研方法：沙箱内 30+ 项文件系统语义与性能实测 + 公开资料对照
> 配套文档：《Kimi Sandbox 技术调研报告》（整体架构部分）

---

## 一、摘要

`fuse.portal` 是 Kimi 自研的文件网关，无公开同名开源实现。它以 FUSE 守护进程形态运行在**沙箱容器之外**（root 身份），通过 Kubernetes 共享挂载传播把文件系统投射进沙箱，后端为 `agent-gw.kimi.com` 云端存储。其本质是**"伪装成本地目录的云端对象存储客户端 + 安全策略执行点"**：数据面 POSIX 语义基本完整，元数据面大面积缺失或作假（chmod/utime 静默吞掉、无链接、无 xattr），单文件硬上限 100 MiB。性能上呈现"元数据极快（stat 中位 33µs）、数据面一般（写 35~187MB/s）"的特征，与 JuiceFS 等生产型云文件系统的设计取向截然不同——前者为**隔离与管控**优化，后者为**吞吐与规模**优化。

## 二、FUSE 技术原理

FUSE（Filesystem in Userspace）由 Miklos Szeredi 于 2001 年提出，核心思想是把文件系统逻辑从内核态迁移到用户态，由两部分组成[^2^]：

- **内核模块 `fuse.ko`**：挂在 VFS 之下，将 `open/read/write` 等系统调用封装为 FUSE 协议请求；
- **用户态守护进程**：阻塞式读取字符设备 `/dev/fuse` 取出请求，在用户空间执行真正的文件逻辑，再将结果写回，内核唤醒等待中的应用[^2^]。

协议本身是简单的客户端-服务器模型：**内核是客户端，daemon 是服务器**。每个请求以 `fuse_in_header` 开头（长度、opcode、请求 ID、nodeid、调用者 uid/gid/pid），daemon 处理后以 `fuse_out_header`（长度、错误码、请求 ID）回复[^1^]。挂载时通过 `FUSE_INIT` 协商协议版本与参数（max_readahead、max_write、时间精度 time_gran 等）[^1^]。

```
应用 (cp/cat/python) → 系统调用 → VFS → fuse.ko → /dev/fuse → 用户态 daemon → 任意后端
```

代价是每次 I/O 多两次上下文切换；收益是无需内核开发、daemon 崩溃不拖垮内核、后端可以是任何东西（sshfs、s3fs、JuiceFS 均基于此）[^2^]。rootless 场景下，Linux 内核自 4.18 起支持在 user namespace 内挂载 FUSE[^3^]。

## 三、portal 的部署形态：三条硬证据【全部实测】

**证据 1 —— 守护进程在沙箱之外。**
沙箱内 `ps aux` 全量进程表无任何 FUSE 进程；`/dev/fuse` 设备节点不存在；`fusermount` 未安装。但挂载参数为 `user_id=0,group_id=0`，说明 daemon 以 **root** 身份启动于沙箱外的可信域（宿主机或特权 sidecar）。

**证据 2 —— 挂载经"传播"进入容器。**
`/proc/self/mountinfo` 记录：

```
4341 4340 0:89 / /mnt/agents rw,nosuid,nodev,relatime master:315 - fuse.portal portal rw,user_id=0,group_id=0,allow_other,max_read=1048576
```

`master:315` 表明该挂载是一个**共享挂载对等组的从属副本**——外部先完成挂载，再通过 mount propagation 送入容器的 mount namespace（K8s `mountPropagation: HostToContainer` 的典型用法）。

**证据 3 —— `allow_other` 与挂载标志。**
FUSE 默认仅允许挂载者本人访问；root 挂载的文件系统要被 uid=999 的沙箱用户读写，必须显式 `allow_other`。配合 `max_read=1048576`（单次读协商上限 1MB）与强制的 `nosuid,nodev`，这是一个为跨身份共享精心配置、同时掐灭提权文件的挂载。

## 四、POSIX 语义能力矩阵【全部实测】

| POSIX 类目 | 实测结果 | 判定 |
|---|---|---|
| open/read/write/close/lseek | 正常，含追加、随机写（限额内 1.1GB/s 写回缓存） | ✅ |
| mkdir/rmdir/rename/unlink | 正常，目录 rename + 递归删除正常 | ✅ |
| mmap（读写） | 写入并读回验证通过 | ✅ |
| flock | 可正常获取 | ✅（跨客户端有效性未知） |
| 写后读一致性 | 同挂载点立即可读 | ✅ |
| 并发追加（4 线程 × 50 行） | 200 行完整无丢失 | ✅ |
| 文件名长度 | 300 字符创建成功（超 POSIX NAME_MAX=255） | ✅（超集） |
| chmod/chown | **静默吞掉**：返回成功但不生效，所有文件固定 root:root 644/755 | ❌ |
| utimensat | **静默吞掉**：mtime/atime 恒为写入时刻，精度仅 1 秒 | ❌ |
| symlink | `Operation not supported` | ❌ |
| link（硬链接） | 失败，且错误码为 ENOENT 而非规范的 EPERM/ENOSYS | ❌ |
| xattr | `ENODATA` | ❌ |
| statfs | 全零（容量/inode 不可查询，`df` 显示 0.0K） | ❌ |
| 稀疏文件 | seek 后写直接 `EIO` | ❌ |
| 单文件上限 | **精确 100 MiB**（104,857,600 字节），超出写返回 EIO；总容量无此限 | ❌（配额） |
| 文件归属 | 一律 root:root，与创建者无关 | ❌（作假） |
| fsync | 0.1ms 返回——不代表数据已达持久层 | ⚠️ 语义弱化 |
| inotify | 本机操作有事件（内核 VFS 本地生成）；跨会话外部变更不会推送 | ⚠️ |

**定位**：portal 是"**读写型子集 POSIX**"。数据面（读写/rename/mmap/锁）基本完整，元数据面大面积缺失或作假。作为参照，生产级云文件系统 JuiceFS 通过了 pjdfstest 全部 8789~8813 项测试[^4^][^5^]，并提供 close-to-open 一致性、原子 rename、unlink 后已打开句柄可续读、fallocate/打洞、xattr、flock 与 fcntl 记录锁[^4^]；在 LTP 约 1270 项文件系统相关测试中通过率超 99%[^6^]。portal 的缺失面若跑 pjdfstest 估计产生数百项失败——但这是**有意为之的安全与简化设计**，而非工程缺陷。

> **实务提醒**：chmod/utime"假装成功"比直接报错更危险——rsync（依赖 mtime 判增量）、`cp -a`、tar、git 等依赖元数据保真的工具会静默产生错误结果。在 `/mnt/agents` 上使用这类工具时不要信任时间戳与权限位。

## 五、性能实测与 JuiceFS 公开数据对照

### 5.1 portal 实测（2 核 / 4GB 沙箱，对照 `/tmp` overlay 本地盘）

| 指标 | fuse.portal | /tmp (overlay) | 倍数 |
|---|---|---|---|
| 顺序写吞吐 | 35~187 MB/s（波动大） | 191 MB/s | 1~5x 慢 |
| 顺序读（冷） | 92 MB/s | — | — |
| 顺序读（page cache 命中） | 1.3 GB/s | 6.8 GB/s | 5x 慢 |
| 小文件创建+写（中位 / p99） | 383 µs / **41 ms** | 33 µs / 92 µs | 11.6x / ~450x |
| stat（中位） | **33 µs** | 3 µs | 11x |
| 小文件读（中位） | 153 µs | 16 µs | 9.6x |

解读：亚毫秒中位延迟说明 daemon 与沙箱同机、元数据大概率在本地内存；p99 偶发 41ms 毛刺说明部分操作穿透到远端。fsync 仅 0.1ms 证实**写路径为本地缓冲 + 异步上传**——重要文件写完后应显式 close，会话突然中断时最后写入的数据可能未落云。

### 5.2 JuiceFS 公开数据

官方对比测试环境为 AWS c5d.18xlarge（72 CPU / 144GB RAM / NVMe 本地缓存盘）+ S3 后端，fio 3.1 顺序读写（bs=4M, size=4G）对比 EFS 与 Goofys[^7^]；官方性能指南同时指出：JuiceFS 顺序读写明显优于 EFS、吞吐超过常用 EBS，但**写小文件不快，因为每次写入都要持久化到对象存储，对象存储 API 有 10~30ms 固定开销**[^8^]。元数据侧，JuiceFS 用 Redis/TiKV 等 KV 引擎承载元数据，官方提供 mdtest/fio 多客户端基准方法[^9^]。

### 5.3 对照结论（量级层面，环境差异见校准声明）

| 维度 | portal（实测） | JuiceFS（公开数据） | 量级判断 |
|---|---|---|---|
| 大文件吞吐 | 写 35~187MB/s，冷读 92MB/s | 官方测试大幅领先 EFS/Goofys[^7^]，缓存命中可达 GB/s 级 | portal 慢约一个量级 |
| 元数据延迟 | stat 中位 **33µs**（本地内存元数据） | 每操作为一次到元数据引擎的网络 RPC（毫秒级为常态），小文件写有 10~30ms 对象存储固定开销[^8^] | **portal 反而快 1~2 个量级** |
| 小文件创建 | 中位 383µs / p99 41ms | 受对象存储写入开销约束[^8^] | 中位 portal 占优，长尾相当 |
| 单文件上限 | 100MiB 硬限制 | 无实际限制 | 不可比（产品策略） |

**矛盾结果的架构解释**：JuiceFS 把工程预算花在数据切片（4MB chunk）、并发直传对象存储与 NVMe 读缓存上，元数据走独立 Redis——换来大吞吐，但元数据延迟下限卡在网络 RPC；portal 把预算花在隔离与管控上——daemon 同机、元数据本地化，换来亚毫秒元数据响应，但数据面受出口带宽与异步上传管道约束，且平台用 100MiB 配额明确表达"不希望你在里面跑重负载"。

**结论：这不是谁快谁慢的问题。** JuiceFS 为"把对象存储当生产存储"优化，portal 为"给不可信代码一个安全的云端文件抽屉"优化；各自在目标负载下达标，互换场景都不及格。

> 校准声明：JuiceFS 数据来自厂商文档（72 核大机型 + 独立元数据引擎）[^7^][^8^]，portal 数据来自 2C4G 沙箱单点实测。除量级结论外，不宜做精确数值相除。

## 六、安全架构：特权外置

"FUSE 需要特权"是常见误解。FUSE 真正需要特权的只有两处：`mount(2)`（需 CAP_SYS_ADMIN，或经 setuid 的 fusermount 助手）与打开 `/dev/fuse`；**读写挂载点的客户端进程零特权**。Kimi 的解法是把这两处特权整体移出沙箱：

| 证据 | 含义 |
|---|---|
| 沙箱内无 FUSE 进程、无 `/dev/fuse`、无 `fusermount` | daemon 与协议通道对沙箱不可达 |
| `master:315` 传播挂载 + daemon `user_id=0` | 特权组件在沙箱外以 root 运行 |
| 沙箱进程 `CapEff=0`，边界集不含 CAP_SYS_ADMIN | 实测 `mount -t tmpfs` 失败 |
| 挂载强制 `nosuid,nodev` | 写入的文件无法成为提权载体 |
| daemon 层禁软链、元数据作假、100MiB 配额 | 防路径逃逸、防元数据滥用、防资源滥用 |

**真正的信任边界**是"沙箱代码作为客户端攻击 daemon"——恶意文件名、异常 flag、并发竞态都经 fuse.ko 格式校验后送达 daemon，daemon 必须自行防御恶意输入；其爆炸半径被限制在按会话隔离的数据面（凭证按 `kimi_chat_id` 签发、只读注入）。

残余攻击面（诚实记录）：沙箱未禁用非特权 user namespace（userns 内实测可挂 tmpfs；内核 4.18 起 userns 支持 FUSE[^3^]，但无 `/dev/fuse` 节点且 userns 内不能 mknod 设备文件，实际不可利用）；探测 shell 未见 seccomp 过滤。

## 七、设计权衡总结

| 替代方案 | 未采用的原因 |
|---|---|
| K8s PV/PVC 挂云盘 | 块设备一对一挂载，无法支撑海量临时 Pod 秒级挂卸载；数据面不受平台管控 |
| NFS/SMB | 需内核客户端与可达存储集群；无内置按会话鉴权 |
| 9p/virtiofs | 绑定虚拟化形态；同样缺少业务层配额/审计钩子 |
| **自研 FUSE 网关（采用）** | daemon 外置=安全边界；对象存储后端=无限弹性；业务语义（配额/隔离/审计）在用户态几行代码实现；跨宿主机型可移植 |

**代价**：性能比本地盘差一个量级、POSIX 元数据语义残缺、fsync 不等于云端持久——对"AI 读写 KB~百 MB 级会话产物"这一场景完全可接受。

## 八、附录：关键实测命令与原始输出（摘录）

```bash
# 挂载信息
$ grep portal /proc/self/mountinfo
4341 4340 0:89 / /mnt/agents rw,nosuid,nodev,relatime master:315 - fuse.portal portal \
  rw,user_id=0,group_id=0,allow_other,max_read=1048576

# 单文件 100MiB 上限
$ dd if=/dev/zero of=big2.bin bs=1M count=512 conv=fdatasync
dd: error writing 'big2.bin': Input/output error
100+0 records out
104857600 bytes (105 MB, 100 MiB) copied, 2.56423 s, 40.9 MB/s

# chmod 静默吞掉
$ chmod 755 a.txt && stat -c "%a" a.txt
644

# utime 静默吞掉（mtime 保持写入时刻，而非指定的 1000000000）
$ python3 -c "import os; os.utime('d.txt',(1000000000,1000000000)); print(os.stat('d.txt').st_mtime)"
1786461181.0

# 时间戳精度仅 1 秒
$ stat -c "mtime:%y" a.txt
mtime:2026-08-11 23:11:56.000000000 +0800

# 300 字符文件名成功（超 NAME_MAX=255）
$ python3 -c "open('x'*300,'w')"   # 无报错

# 注入配置（密钥已脱敏）
$ cat /mnt/agents/.agent-gw.json
{"api_key":"sk-kimi-<REDACTED>","base_url":"https://agent-gw.kimi.com/coding","kimi_chat_id":"<REDACTED>"}
```

---

## 参考资料

[^1^]: fuse(4) — Linux manual page（FUSE 内核协议：fuse_in_header/fuse_out_header/FUSE_INIT）: https://man7.org/linux/man-pages/man4/fuse.4.html
[^2^]: The Design Journey of FUSE: From Kernel-Space to User-Space File Systems — JuiceFS Blog: https://juicefs.com/en/blog/engineering/design-fuse-kernel-user-space
[^3^]: JuiceFS mount fails inside unprivileged user namespace (issue #6988，述及内核 4.18 起 userns 支持 FUSE): https://github.com/juicedata/juicefs/issues/6988
[^4^]: POSIX 兼容性 — JuiceFS 社区版文档（pjdfstest 8789 项全通过；close-to-open、原子 rename、fallocate、xattr、flock/fcntl）: https://juicefs.com/docs/zh/community/posix_compatibility/
[^5^]: POSIX compatibility — JuiceFS 云服务文档（pjdfstest 8813 项全通过；LTP）: https://juicefs.com/docs/zh/cloud/reference/posix_compatibility/
[^6^]: JuiceFS POSIX 兼容性实践（LTP 1270 项中 5 失败 4 跳过，通过率 >99%）: https://blog.csdn.net/gitblog_00795/article/details/151411908
[^7^]: JuiceFS 与 EFS、Goofys 对比测试（fio 3.1，c5d.18xlarge，S3）— JuiceFS 官方文档: https://juicefs.com/docs/zh/cloud/benchmark/efs_goofys_comparison/
[^8^]: 性能评估指南（小文件写有 10~30ms 对象存储固定开销）— JuiceFS 官方文档: https://juicefs.com/docs/zh/community/performance_evaluation_guide/
[^9^]: 元数据引擎性能测试（mdtest/fio 基准方法）— JuiceFS 官方文档: https://juicefs.com/docs/zh/community/metadata_engines_benchmark/
