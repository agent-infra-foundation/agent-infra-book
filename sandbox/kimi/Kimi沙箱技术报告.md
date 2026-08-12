# Kimi Sandbox 技术调研报告

> 调研日期：2026-08-11 / 2026-08-12 调研方法：在沙箱内部执行 40+ 条探测命令（内核/容器/进程/网络/存储/权限实测），结合公开资料分析 性质声明：本报告内容分为两类——标注【实测】的为沙箱内直接观测结果；标注【推断】的为基于证据的合理推测。沙箱边界之外的服务端实现无法从内部观测，不在本报告断言范围内。

---

## 一、摘要

Kimi 的代码执行沙箱是一个运行在 **Kubernetes** 之上的 **containerd 容器**：宿主机内核为阿里云 LifseaOS 定制内核，容器内为 Debian 12 用户态，以非 root 用户（uid=999）运行，配额 2 核 CPU / 4GB 内存 / 30GB 磁盘。跨会话持久化通过一个\*\*自研 FUSE 文件网关（fuse.portal）\*\*实现：守护进程以 root 身份运行在沙箱容器之外，挂载点经 K8s 共享挂载传播送入容器，后端连接 `agent-gw.kimi.com` 云端存储，按会话隔离。安全模型的核心是"**特权外置**"——沙箱内没有任何挂载能力、没有 `/dev/fuse`、capabilities 为空，不可信代码（AI 生成的任意代码）自始至终只是文件系统的普通客户端。

整体架构与业界 AI 代码沙箱（ChatGPT Code Interpreter 等）思路一致，但"FUSE 守护进程外置 \+ 传播挂载"的做法在安全边界上更进一步。

## 二、基础设施层

| 维度 | 观测结果 | 判据 |
| :---- | :---- | :---- |
| 容器编排 | Kubernetes（QoS 档位 burstable）【实测】 | cgroup 路径 `/kubepods/burstable/pod<uuid>/...` |
| 容器运行时 | containerd，overlayfs 快照器【实测】 | 根挂载 lowerdir 来自 `io.containerd.snapshotter.v1.overlayfs`，可观测 400+ 镜像只读层 |
| 宿主机内核 | `5.10.134-18.0.11.lifsea8.x86_64`【实测】 | `uname -a`；"lifsea" 为阿里云容器优化系统 LifseaOS 内核【推断：底层为阿里云基础设施】 |
| 容器用户态 | Debian GNU/Linux 12 (bookworm)【实测】 | `/etc/os-release` |
| init 系统 | s6（PID 1 \= `s6-svscan`）【实测】 | 进程表；s6 监管 kasmvnc、kernel-server、sshd、socat、browser-guard 等服务 |
| 主机名 | `k2087191046178906117`（按实例分配）【实测】 | `hostname` |

## 三、资源配额【实测】

| 资源 | 配额 | 备注 |
| :---- | :---- | :---- |
| CPU | 2 核 | `nproc` |
| 内存 | 4.0 GiB，无 swap | `free -h` |
| 根磁盘 | 30 GB（overlay，已用约 5.5G） | `df -h` |
| `/tmp` | 在 overlay 根层上，**容器销毁即丢** | 属临时存储 |
| `/mnt/agents` | 独立 FUSE 挂载，**跨会话持久** | 详见 FUSE 专项报告 |

## 四、容器内服务组件【实测】

沙箱不是裸容器，而是一套面向 AI agent 的工作环境，`ps aux` 可见以下组件：

| 组件 | 形态 | 作用【推断】 |
| :---- | :---- | :---- |
| `kernel_server.py`（端口 8888，kimi 用户） | Python 服务 | 代码执行内核网关（Jupyter 协议），agent 的 shell/ipython 工具入口 |
| `ipykernel_launcher` | Jupyter 内核 | 持久 Python 会话 |
| `browser_guard.py` \+ Chromium 150 | 无头浏览器（`--no-sandbox`，单进程） | 网页访问/截图/浏览器自动化；经 `--proxy-server=10.86.13.73:5900` 出网 |
| `Xvnc`（KasmVNC，:99，1920x1080） | 虚拟显示 \+ VNC | 图形界面渲染，支撑"电脑使用"能力 |
| `socat TCP-LISTEN:9223 → localhost:9222` | 端口转发 | 暴露 Chrome DevTools 协议 |
| `sshd` \+ 多个 `sftp-server` 会话 | SSH/SFTP | 平台与沙箱之间的文件传输通道（与 FUSE 并存的第二条数据通路） |

## 五、网络【实测】

- **出网可用**：`https://pypi.org`、`https://www.baidu.com` 均返回 200；ICMP 可 ping 通 8.8.8.8（RTT 约 200ms，明显经过网关/代理）。  
- **无显式代理变量**：shell 环境无 `HTTP_PROXY`，但 Chromium 被显式配置了 `10.86.13.73:5900` 代理——说明出口走透明网关，浏览器流量单独受控【推断：出口有内容审计与域名策略】。  
- **DNS**：集群内 CoreDNS（`nameserver 192.168.0.10`，`*.svc.cluster.local` 搜索域），典型 K8s Pod 网络。  
- 部分站点（如 ifconfig.me）无响应，符合"白名单/审计式出口网关"特征【推断】。

## 六、存储体系

沙箱内存在两条截然不同的存储路径：

| 路径 | 实现 | 持久性 | 特征 |
| :---- | :---- | :---- | :---- |
| `/`（含 `/tmp`、`/home`） | containerd overlayfs，宿主机本地 | 会话结束即销毁 | 本地盘性能（顺序写 191MB/s，缓存读 6.8GB/s），完整 POSIX |
| `/mnt/agents` | **fuse.portal**（自研 FUSE 网关） | 跨会话持久 | 受限 POSIX（无软链/硬链/xattr，单文件 100MiB 上限），写约 35\~187MB/s |

`/mnt/agents` 下的功能分区【实测】：`upload/`（用户上传，只读）、`output/`（交付产物，对用户可见）、`.store/`（会话元数据）、`.tmp/`、`deploy/`、`images/`，以及注入的只读配置 `.agent-gw.json`（含 `base_url: https://agent-gw.kimi.com/coding` 和按会话 `kimi_chat_id` 签发的 API 凭证，权限 444）。

**FUSE 网关的完整分析见配套报告《Kimi 沙箱 FUSE 文件系统（fuse.portal）深度报告》。**

## 七、安全模型

### 7.1 权限剥离【全部实测】

| 检查项 | 结果 |
| :---- | :---- |
| 运行用户 | `kimi`，uid=999，非 root |
| 有效 capabilities | `CapEff = 0`（一个都不持有） |
| capability 边界集 | `a80425fb`（Docker 默认集，**不含 CAP\_SYS\_ADMIN**） |
| `mount -t tmpfs` | 失败："must be superuser" |
| `sudo` | 需要密码，无提权路径 |
| `/dev/fuse` | 不存在 |
| `fusermount` / `fusermount3` | 未安装 |
| seccomp | 探测 shell 进程显示 `Seccomp: 0`（无过滤器） |

### 7.2 值得注意的残余攻击面【实测 \+ 推断】

- **非特权 user namespace 未禁用**：`unshare -Urm` 后在 userns 内挂载 tmpfs 成功。userns 是隔离作用域、影响不出自身，但历史上是内核提权漏洞高发面；保留它大概率是为了 Chromium 的沙箱机制。内核 userns 内支持挂载 FUSE（Linux 4.18 起）[^1]，但沙箱内无 `/dev/fuse` 设备节点且 userns 内无法 mknod 设备文件，此路实际不通。  
- **无 seccomp 裁剪**：系统调用面完整暴露给非 root 用户，边界完全依赖"非 root \+ capability 边界集 \+ namespace 隔离 \+ 设备不暴露"。  
- **会话凭证可读**：`.agent-gw.json` 中的 API key 对沙箱内代码可读；缓解方式是凭证按会话隔离、只读注入、爆炸半径限于本会话数据。

### 7.3 安全架构的核心思想

不把特权"保护"在沙箱内，而是**让沙箱内根本不存在特权**：FUSE daemon、/dev/fuse、mount 权限全部位于容器之外（见 FUSE 专项报告）；出网走受控网关；文件数据面经 daemon 单点管控（配额、无软链防逃逸、nosuid/nodev）。

## 八、架构总览图

┌─────────────────────── Kubernetes 集群（阿里云 LifseaOS 宿主机）───────────────────────┐

│                                                                                       │

│  ┌── Pod（burstable）──────────────────────────────────────────────────────────────┐  │

│  │  容器（containerd / Debian 12 / 2C4G / s6 init / 用户 kimi uid=999）            │  │

│  │                                                                                │  │

│  │   kernel\_server:8888   ipykernel   Chromium(经代理出网)   Xvnc :99   sshd/sftp │  │

│  │                                                                                │  │

│  │   / (overlay, 临时)        /mnt/agents ──挂载传播(master:315)──┐               │  │

│  └────────────────────────────────────────────────────────────────│──────────────┘  │

│                                                                    │                │

│                          ┌── fuse.portal daemon（root，沙箱外）◄───┘                │

│                          │   持有 /dev/fuse，实施配额/策略/审计                     │

│                          └──────────────┬──────────────────────────                  │

└─────────────────────────────────────────│───────────────────────────────────────────┘

                                          ▼

                          agent-gw.kimi.com 云端存储（按 kimi\_chat\_id 隔离）

## 九、局限与未尽事项

1. Pod 调度策略、镜像构建链、daemon 的具体进程形态（宿主机 vs sidecar）在容器内不可观测。  
2. 云端存储后端类型（对象存储 vs 块存储 \+ 自研协议）只能从行为特征推断，未实锤。  
3. 会话间隔离强度、网关审计策略、出口白名单清单无法从内部验证。  
4. 未做破坏性/对抗性测试（本调研均为只读探测与常规文件操作）。

---

## 参考资料

[^1]: JuiceFS mount fails inside unprivileged user namespace (issue \#6988，述及内核 4.18 起 userns 支持 FUSE): [https://github.com/juicedata/juicefs/issues/6988](https://github.com/juicedata/juicefs/issues/6988)