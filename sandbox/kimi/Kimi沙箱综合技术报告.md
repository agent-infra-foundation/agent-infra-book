# Kimi 沙箱综合技术报告

> 调研日期：2026-08-11 / 2026-08-12  
> 调研方法：在沙箱内部执行 40+ 条内核、容器、进程、网络、存储、权限和文件系统探测命令，并结合公开资料对照。  
> 合并说明：本文合并了《Kimi Sandbox 技术调研报告》和《Kimi 沙箱 FUSE 文件系统（fuse.portal）深度报告》，以整体架构为主线，保留 FUSE 文件网关的详细证据、语义矩阵、性能测试与安全分析。  
> 证据边界：标注【实测】的是沙箱内直接观测结果；标注【推断】的是基于证据的合理推测。沙箱边界之外的服务端实现无法从内部观测，不在本文断言范围内。

---

## 一、摘要

Kimi 的代码执行沙箱是一个运行在 **Kubernetes** 之上的 **containerd 容器**：宿主机内核为阿里云 LifseaOS 定制内核，容器内为 Debian 12 用户态，以非 root 用户（uid=999）运行，配额约为 2 核 CPU、4GB 内存和 30GB 磁盘。

沙箱内的临时工作区位于 containerd overlayfs 根层，随会话销毁；跨会话持久化则通过自研 FUSE 文件网关 `fuse.portal` 实现。FUSE 守护进程以 root 身份运行在沙箱容器之外，持有挂载所需的特权，通过 Kubernetes 共享挂载传播把文件系统投射进沙箱，后端连接 `agent-gw.kimi.com` 云端存储并按会话隔离。

这一架构的核心不是给沙箱内代码授予挂载权限，而是**把特权整体外置**：沙箱内没有挂载能力、没有 `/dev/fuse`、没有 `CAP_SYS_ADMIN`，不可信代码始终只是文件系统客户端。`/mnt/agents` 上的数据面 POSIX 语义基本完整，但元数据语义被主动简化：chmod/utime 静默吞掉、没有软链接/硬链接/xattr、statfs 不提供容量信息、单文件硬上限为 100 MiB。

性能表现也体现了这一目标取舍：元数据操作很快（`stat` 中位约 33µs），但数据面通常慢于本地盘（顺序写约 35~187MB/s，冷读约 92MB/s），并且 `fsync` 的快速返回不等于数据已落到云端。整体上，`fuse.portal` 更像是**伪装成本地目录的云端对象存储客户端 + 安全策略执行点**，优化目标是隔离、配额和可管控性，而不是通用生产文件系统的吞吐和完整 POSIX 兼容性。

## 二、基础设施层【实测】

| 维度 | 观测结果 | 判据 |
| :--- | :--- | :--- |
| 容器编排 | Kubernetes，QoS 档位为 burstable | cgroup 路径 `/kubepods/burstable/pod<uuid>/...` |
| 容器运行时 | containerd，overlayfs 快照器 | 根挂载 lowerdir 来自 `io.containerd.snapshotter.v1.overlayfs`，可观测 400+ 镜像只读层 |
| 宿主机内核 | `5.10.134-18.0.11.lifsea8.x86_64` | `uname -a`；“lifsea” 指向阿里云容器优化系统 LifseaOS【推断：底层为阿里云基础设施】 |
| 容器用户态 | Debian GNU/Linux 12 (bookworm) | `/etc/os-release` |
| init 系统 | s6，PID 1 为 `s6-svscan` | 进程表；s6 监管 kasmvnc、kernel-server、sshd、socat、browser-guard 等服务 |
| 主机名 | `k2087191046178906117`，按实例分配 | `hostname` |

## 三、资源配额【实测】

| 资源 | 配额 | 备注 |
| :--- | :--- | :--- |
| CPU | 2 核 | `nproc` |
| 内存 | 4.0 GiB，无 swap | `free -h` |
| 根磁盘 | 30 GB，overlay，已用约 5.5G | `df -h` |
| `/tmp` | 位于 overlay 根层 | 容器销毁即丢失，属于临时存储 |
| `/mnt/agents` | 独立 FUSE 挂载 | 跨会话持久，单文件上限 100 MiB |

## 四、容器内服务组件【实测 + 推断】

| 组件 | 形态 | 作用【推断】 |
| :--- | :--- | :--- |
| `kernel_server.py`（端口 8888，kimi 用户） | Python 服务 | 代码执行内核网关（Jupyter 协议），agent 的 shell/IPython 工具入口 |
| `ipykernel_launcher` | Jupyter 内核 | 持久 Python 会话 |
| `browser_guard.py` + Chromium 150 | 无头浏览器，`--no-sandbox`，单进程 | 网页访问、截图和浏览器自动化；经 `--proxy-server=10.86.13.73:5900` 出网 |
| `Xvnc`（KasmVNC，`:99`，1920x1080） | 虚拟显示 + VNC | 图形界面渲染，支撑“电脑使用”能力 |
| `socat TCP-LISTEN:9223 → localhost:9222` | 端口转发 | 暴露 Chrome DevTools 协议 |
| `sshd` + 多个 `sftp-server` 会话 | SSH/SFTP | 平台与沙箱之间的文件传输通道，与 FUSE 并存的第二条数据通路 |

## 五、网络【实测 + 推断】

- **出网可用**：`https://pypi.org`、`https://www.baidu.com` 均返回 200；ICMP 可 ping 通 `8.8.8.8`，RTT 约 200ms，明显经过网关或代理。
- **无显式代理变量**：shell 环境没有 `HTTP_PROXY`，但 Chromium 被显式配置为使用 `10.86.13.73:5900`，说明出口走透明网关，浏览器流量单独受控【推断：出口可能有内容审计与域名策略】。
- **DNS**：集群内 CoreDNS，`nameserver 192.168.0.10`，搜索域包含 `*.svc.cluster.local`，符合典型 Kubernetes Pod 网络。
- 部分站点（如 `ifconfig.me`）无响应，符合白名单或审计式出口网关的特征【推断】。

## 六、存储体系总览

沙箱内存在两条用途截然不同的存储路径：

| 路径 | 实现 | 持久性 | 特征 |
| :--- | :--- | :--- | :--- |
| `/`（含 `/tmp`、`/home`） | containerd overlayfs，宿主机本地 | 会话结束即销毁 | 本地盘性能，完整 POSIX；顺序写约 191MB/s，缓存读约 6.8GB/s |
| `/mnt/agents` | `fuse.portal` 自研 FUSE 网关 | 跨会话持久 | 受限 POSIX；无软链接、硬链接和 xattr，单文件 100 MiB 上限；写约 35~187MB/s |

`/mnt/agents` 下可观测到以下功能分区【实测】：

- `upload/`：用户上传内容，只读；
- `output/`：交付产物，对用户可见；
- `.store/`：会话元数据；
- `.tmp/`、`deploy/`、`images/`：运行时和交付相关目录；
- `.agent-gw.json`：注入的只读配置，权限为 444，包含 `base_url: https://agent-gw.kimi.com/coding` 和按会话签发的 `kimi_chat_id` 凭证（密钥已脱敏）。

`/tmp` 适合缓存、编译中间产物和可重建数据；`/mnt/agents` 适合跨会话保留的输入、输出和中小型交付物。不要把 `/mnt/agents` 当成完整的 POSIX 生产文件系统：不要依赖 chmod、mtime、xattr、链接、statfs 或超过 100 MiB 的单文件写入。

## 七、FUSE 技术原理

FUSE（Filesystem in Userspace）由 Miklos Szeredi 于 2001 年提出，核心思想是把文件系统逻辑从内核态迁移到用户态，由两部分组成[^2]：

- **内核模块 `fuse.ko`**：挂在 VFS 之下，将 `open`、`read`、`write` 等系统调用封装为 FUSE 协议请求；
- **用户态守护进程**：阻塞式读取字符设备 `/dev/fuse` 取得请求，在用户空间执行真正的文件逻辑，再将结果写回，让内核唤醒等待中的应用。

协议本身是客户端—服务器模型：**内核是客户端，daemon 是服务器**。每个请求以 `fuse_in_header` 开头（长度、opcode、请求 ID、nodeid、调用者 uid/gid/pid），daemon 处理后以 `fuse_out_header`（长度、错误码、请求 ID）回复[^1]。挂载时通过 `FUSE_INIT` 协商协议版本与参数，包括 `max_readahead`、`max_write` 和时间精度 `time_gran`[^1]。

~~~text
应用 (cp/cat/python) → 系统调用 → VFS → fuse.ko → /dev/fuse → 用户态 daemon → 任意后端
~~~

代价是每次 I/O 增加上下文切换；收益是无需编写内核文件系统、daemon 崩溃通常不拖垮内核，并且后端可以是任意系统（sshfs、s3fs、JuiceFS 均采用这一模式）[^2]。rootless 场景下，Linux 内核自 4.18 起支持在 user namespace 内挂载 FUSE[^3]。

## 八、`fuse.portal` 的部署形态【全部实测】

### 8.1 守护进程位于沙箱之外

沙箱内 `ps aux` 的全量进程表中没有 FUSE 进程；`/dev/fuse` 设备节点不存在；`fusermount` 未安装。但挂载参数为 `user_id=0,group_id=0`，说明 daemon 以 **root** 身份运行在沙箱外的可信域，具体可能是宿主机或特权 sidecar。

### 8.2 挂载经 mount propagation 进入容器

`/proc/self/mountinfo` 记录：

~~~text
4341 4340 0:89 / /mnt/agents rw,nosuid,nodev,relatime master:315 - fuse.portal portal rw,user_id=0,group_id=0,allow_other,max_read=1048576
~~~

`master:315` 表明该挂载属于共享挂载对等组的从属副本：外部先完成挂载，再通过 mount propagation 送入容器的 mount namespace，符合 Kubernetes `mountPropagation: HostToContainer` 的典型用法。

### 8.3 `allow_other` 与挂载标志

FUSE 默认只允许挂载者本人访问。root 挂载的文件系统要被 uid=999 的沙箱用户读写，必须显式使用 `allow_other`。同时，`max_read=1048576` 表明单次读协商上限为 1 MiB，`nosuid,nodev` 则禁止挂载内文件成为 setuid 或设备提权载体。这是一套为跨身份共享而配置、同时压缩提权面的挂载参数。

## 九、POSIX 语义能力矩阵【全部实测】

| POSIX 类目 | 实测结果 | 判定 |
| :--- | :--- | :--- |
| `open/read/write/close/lseek` | 正常，含追加、随机写；限额内写回缓存可达约 1.1GB/s | ✅ |
| `mkdir/rmdir/rename/unlink` | 正常，目录 rename 与递归删除正常 | ✅ |
| `mmap`（读写） | 写入并读回验证通过 | ✅ |
| `flock` | 可正常获取；跨客户端有效性未知 | ✅ |
| 写后读一致性 | 同一挂载点立即可读 | ✅ |
| 并发追加（4 线程 × 50 行） | 200 行完整无丢失 | ✅ |
| 文件名长度 | 300 字符创建成功，超过 POSIX `NAME_MAX=255` | ✅，超集 |
| `chmod/chown` | 静默吞掉：返回成功但不生效，文件固定为 `root:root`、644/755 | ❌ |
| `utimensat` | 静默吞掉：mtime/atime 保持写入时刻，精度仅 1 秒 | ❌ |
| symlink | `Operation not supported` | ❌ |
| hard link | 失败，错误码为 ENOENT，而非规范的 EPERM/ENOSYS | ❌ |
| xattr | `ENODATA` | ❌ |
| `statfs` | 全零，容量/inode 不可查询，`df` 显示 0.0K | ❌ |
| 稀疏文件 | seek 后写直接返回 `EIO` | ❌ |
| 单文件上限 | 精确 100 MiB（104,857,600 字节），超出写入返回 `EIO`；总容量无此限 | ❌，配额约束 |
| 文件归属 | 一律 `root:root`，与创建者无关 | ❌，作假 |
| `fsync` | 约 0.1ms 返回，不代表数据已到持久层 | ⚠️ 语义弱化 |
| `inotify` | 本机操作有事件；跨会话外部变更不会推送 | ⚠️ |

### 9.1 兼容性结论

`fuse.portal` 是“读写型子集 POSIX”：数据面（读写、rename、mmap、锁）基本完整，元数据面大面积缺失或作假。作为参照，生产级云文件系统 JuiceFS 通过了 pjdfstest 的全部 8789~8813 项测试，并提供 close-to-open 一致性、原子 rename、unlink 后已打开句柄可续读、fallocate/打洞、xattr、flock 与 fcntl 记录锁[^4][^5]；在约 1270 项 LTP 文件系统相关测试中通过率超过 99%[^6]。`fuse.portal` 若运行 pjdfstest，预计会在元数据和配额相关项目上产生大量失败，但这更像是有意为之的安全与简化设计，而非通用文件系统实现缺陷。

### 9.2 工具链风险

chmod/utime“假装成功”比直接报错更危险。依赖 mtime 或权限元数据的 `rsync`、`cp -a`、tar 和 git 可能静默产生错误结果。在 `/mnt/agents` 上使用这些工具时，不应把时间戳、权限位和文件归属视为可信事实。

## 十、性能实测与 JuiceFS 对照

### 10.1 portal 与本地 overlay 对照

测试环境为 2 核 CPU / 4GB 内存沙箱；本地对照目录为 `/tmp` overlay。

| 指标 | `fuse.portal` | `/tmp` overlay | 差异 |
| :--- | :--- | :--- | :--- |
| 顺序写吞吐 | 35~187 MB/s，波动大 | 191 MB/s | 约 1~5 倍慢 |
| 顺序读（冷） | 92 MB/s | — | — |
| 顺序读（page cache 命中） | 1.3 GB/s | 6.8 GB/s | 约 5 倍慢 |
| 小文件创建+写（中位 / p99） | 383µs / **41ms** | 33µs / 92µs | 中位约 11.6 倍慢，p99 约 450 倍 |
| `stat`（中位） | **33µs** | 3µs | 约 11 倍慢 |
| 小文件读（中位） | 153µs | 16µs | 约 9.6 倍慢 |

亚毫秒级中位延迟说明 daemon 与沙箱同机，元数据大概率位于本地内存；小文件操作偶发 41ms 毛刺，说明部分操作会穿透到远端。`fsync` 仅约 0.1ms 返回，支持“本地缓冲 + 异步上传”的推测。因此，重要文件写完后应显式关闭文件；会话突然中断时，最后写入的数据可能尚未落云。

### 10.2 与 JuiceFS 公开数据的量级对照

JuiceFS 官方对比测试使用 AWS c5d.18xlarge（72 CPU / 144GB RAM / NVMe 本地缓存盘）和 S3 后端，以 fio 3.1 对比 EFS 与 Goofys[^7]。官方性能指南同时指出，JuiceFS 顺序读写明显优于 EFS、吞吐超过常用 EBS，但小文件写入不快，因为每次写入都要持久化到对象存储，对象存储 API 会带来约 10~30ms 固定开销[^8]。元数据侧，JuiceFS 使用 Redis/TiKV 等 KV 引擎，并提供 mdtest/fio 多客户端基准方法[^9]。

| 维度 | portal（本次实测） | JuiceFS（公开数据） | 量级判断 |
| :--- | :--- | :--- | :--- |
| 大文件吞吐 | 写 35~187MB/s，冷读 92MB/s | 官方测试大幅领先 EFS/Goofys，缓存命中可达 GB/s 级[^7] | portal 慢约一个量级 |
| 元数据延迟 | `stat` 中位 **33µs**，本地化特征明显 | 每次操作通常涉及到元数据引擎的网络 RPC；小文件写受 10~30ms 对象存储开销影响[^8] | portal 反而快 1~2 个量级 |
| 小文件创建 | 中位 383µs，p99 41ms | 受对象存储写入开销约束[^8] | 中位 portal 占优，长尾相当 |
| 单文件上限 | 100MiB 硬限制 | 无实际限制 | 产品策略不可直接比较 |

这不是谁更快的问题，而是目标负载不同：JuiceFS 把工程预算花在数据切片、并发直传对象存储和 NVMe 读缓存上，优化“把对象存储当生产存储”；portal 把预算花在隔离、配额和管控上，优化“给不可信代码一个安全的云端文件抽屉”。

> **校准声明**：JuiceFS 数据来自厂商文档（72 核大机型 + 独立元数据引擎），portal 数据来自 2C4G 沙箱单点实测。除量级结论外，不宜做精确数值相除。

## 十一、安全模型：特权外置

### 11.1 权限剥离【全部实测】

| 检查项 | 结果 |
| :--- | :--- |
| 运行用户 | `kimi`，uid=999，非 root |
| 有效 capabilities | `CapEff = 0`，一个都不持有 |
| capability 边界集 | `a80425fb`，Docker 默认集，不含 `CAP_SYS_ADMIN` |
| `mount -t tmpfs` | 失败：`must be superuser` |
| `sudo` | 需要密码，无提权路径 |
| `/dev/fuse` | 不存在 |
| `fusermount` / `fusermount3` | 未安装 |
| seccomp | 探测 shell 进程显示 `Seccomp: 0`，未见过滤器 |

### 11.2 安全边界的实现

FUSE 真正需要特权的地方只有 `mount(2)`（通常需要 `CAP_SYS_ADMIN`，或经 setuid 的 fusermount 助手）和打开 `/dev/fuse`；读写已经挂载的目录不需要特权。Kimi 的做法是将这两处特权整体移出沙箱：

| 证据 | 含义 |
| :--- | :--- |
| 沙箱内无 FUSE 进程、无 `/dev/fuse`、无 `fusermount` | daemon 与协议通道对沙箱不可达 |
| `master:315` 传播挂载 + daemon `user_id=0` | 特权组件在沙箱外以 root 运行 |
| 沙箱进程 `CapEff=0`，边界集不含 `CAP_SYS_ADMIN` | 实测 `mount -t tmpfs` 失败 |
| 挂载强制 `nosuid,nodev` | 写入文件无法成为 setuid 或设备提权载体 |
| daemon 层禁软链、弱化元数据、限制 100MiB | 防路径逃逸、元数据滥用和资源滥用 |

真正的信任边界是“沙箱代码作为客户端攻击 daemon”：恶意文件名、异常 flag 和并发竞态都可能经 FUSE 协议送达 daemon，daemon 必须自行防御恶意输入。其爆炸半径被限制在按会话隔离的数据面，凭证按 `kimi_chat_id` 签发并以只读配置注入。

### 11.3 残余攻击面【实测 + 推断】

- **非特权 user namespace 未禁用**：执行 `unshare -Urm` 后可在 user namespace 内挂载 tmpfs。user namespace 是隔离作用域，影响通常不出自身，但历史上是内核提权漏洞高发面；保留它大概率是为了 Chromium 的沙箱机制。
- **user namespace 内的 FUSE 路径实际不通**：虽然 Linux 4.18 起支持在 user namespace 内挂载 FUSE[^3]，但沙箱内没有 `/dev/fuse`，且 user namespace 内不能创建该设备文件。
- **未见 seccomp 裁剪**：系统调用面完整暴露给非 root 用户，边界主要依赖非 root 身份、capability 边界集、namespace 隔离和设备不暴露。
- **会话凭证可读**：`.agent-gw.json` 中的 API key 对沙箱内代码可读；缓解方式是凭证按会话隔离、只读注入，并将爆炸半径限制在本会话数据。

## 十二、架构总览

~~~text
┌────────────────────── Kubernetes 集群（阿里云 LifseaOS 宿主机）──────────────────────┐
│                                                                                    │
│  ┌── Pod（burstable）───────────────────────────────────────────────────────────┐  │
│  │ 容器（containerd / Debian 12 / 2C4G / s6 init / kimi uid=999）              │  │
│  │                                                                              │  │
│  │ kernel_server:8888  ipykernel  Chromium(代理出网)  Xvnc :99  sshd/sftp      │  │
│  │                                                                              │  │
│  │  / (overlay, 临时)      /mnt/agents ──挂载传播(master:315)──┐                │  │
│  └─────────────────────────────────────────────────────────────│────────────────┘  │
│                                                                │                   │
│                        ┌── fuse.portal daemon（root，沙箱外）◄─┘                   │
│                        │   持有 /dev/fuse，实施配额 / 策略 / 审计                  │
│                        └─────────────┬──────────────────────────                   │
└──────────────────────────────────────│────────────────────────────────────────────┘
                                       ▼
                       agent-gw.kimi.com 云端存储（按 kimi_chat_id 隔离）
~~~

## 十三、设计权衡

| 替代方案 | 未采用或不优先采用的原因 |
| :--- | :--- |
| K8s PV/PVC 挂云盘 | 块设备一对一挂载，难以支撑海量临时 Pod 的秒级挂卸载；数据面也不容易由平台统一管控 |
| NFS/SMB | 需要内核客户端和可达存储集群，缺少内置的按会话鉴权与业务策略钩子 |
| 9p/virtiofs | 绑定特定虚拟化形态，同样缺少业务层配额和审计钩子 |
| **自研 FUSE 网关** | daemon 外置形成安全边界；对象存储后端提供弹性；配额、隔离和审计可在用户态实现；跨宿主机型可移植 |

**代价**：数据性能比本地盘差，POSIX 元数据语义残缺，`fsync` 不等于云端持久化。对“AI 读写 KB 到百 MB 级会话产物”的工作负载，这一代价可以接受。

## 十四、局限与未尽事项

1. Pod 调度策略、镜像构建链以及 daemon 的具体进程形态（宿主机还是 sidecar）无法从容器内部观测。
2. 云端存储后端类型（对象存储，或块存储加自研协议）只能从行为特征推断，尚未实锤。
3. 会话之间的隔离强度、网关审计策略和出口白名单清单无法从内部验证。
4. 本调研没有做破坏性或对抗性测试，仅包含只读探测和常规文件操作。
5. JuiceFS 对照数据来自规模和硬件配置完全不同的公开基准，只适合作量级参考。

## 十五、附录：关键实测命令与原始输出摘录

### 15.1 挂载信息

~~~bash
$ grep portal /proc/self/mountinfo
4341 4340 0:89 / /mnt/agents rw,nosuid,nodev,relatime master:315 - fuse.portal portal \
  rw,user_id=0,group_id=0,allow_other,max_read=1048576
~~~

### 15.2 单文件 100 MiB 上限

~~~bash
$ dd if=/dev/zero of=big2.bin bs=1M count=512 conv=fdatasync
dd: error writing 'big2.bin': Input/output error
100+0 records out
104857600 bytes (105 MB, 100 MiB) copied, 2.56423 s, 40.9 MB/s
~~~

### 15.3 元数据语义

~~~bash
# chmod 静默吞掉
$ chmod 755 a.txt && stat -c "%a" a.txt
644

# utime 静默吞掉：mtime 保持写入时刻，而非指定的 1000000000
$ python3 -c "import os; os.utime('d.txt',(1000000000,1000000000)); print(os.stat('d.txt').st_mtime)"
1786461181.0

# 时间戳精度仅 1 秒
$ stat -c "mtime:%y" a.txt
mtime:2026-08-11 23:11:56.000000000 +0800

# 300 字符文件名成功，超出 NAME_MAX=255
$ python3 -c "open('x'*300,'w')"
~~~

### 15.4 单文件注入配置（密钥已脱敏）

~~~bash
$ cat /mnt/agents/.agent-gw.json
{"api_key":"sk-kimi-<REDACTED>","base_url":"https://agent-gw.kimi.com/coding","kimi_chat_id":"<REDACTED>"}
~~~

## 参考资料

[^1]: [fuse(4) — Linux manual page](https://man7.org/linux/man-pages/man4/fuse.4.html)，介绍 FUSE 内核协议中的 `fuse_in_header`、`fuse_out_header` 和 `FUSE_INIT`。
[^2]: [The Design Journey of FUSE: From Kernel-Space to User-Space File Systems — JuiceFS Blog](https://juicefs.com/en/blog/engineering/design-fuse-kernel-user-space)。
[^3]: [JuiceFS mount fails inside unprivileged user namespace — issue #6988](https://github.com/juicedata/juicefs/issues/6988)，涉及 Linux 4.18 起 user namespace 对 FUSE 的支持。
[^4]: [JuiceFS 社区版 POSIX 兼容性](https://juicefs.com/docs/zh/community/posix_compatibility/)，包含 pjdfstest、close-to-open、原子 rename、fallocate、xattr 和锁语义说明。
[^5]: [JuiceFS 云服务 POSIX compatibility](https://juicefs.com/docs/zh/cloud/reference/posix_compatibility/)，包含 pjdfstest 与 LTP 结果。
[^6]: [JuiceFS POSIX 兼容性实践](https://blog.csdn.net/gitblog_00795/article/details/151411908)，涉及 LTP 文件系统测试通过率。
[^7]: [JuiceFS 与 EFS、Goofys 对比测试](https://juicefs.com/docs/zh/cloud/benchmark/efs_goofys_comparison/)，使用 fio 3.1、c5d.18xlarge 和 S3。
[^8]: [JuiceFS 性能评估指南](https://juicefs.com/docs/zh/community/performance_evaluation_guide/)，讨论小文件写入的对象存储固定开销。
[^9]: [JuiceFS 元数据引擎性能测试](https://juicefs.com/docs/zh/community/metadata_engines_benchmark/)，介绍 mdtest/fio 基准方法。

