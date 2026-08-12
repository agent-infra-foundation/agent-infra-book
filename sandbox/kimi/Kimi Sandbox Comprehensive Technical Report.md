# Kimi Sandbox Comprehensive Technical Report

> Research dates: 2026-08-11 / 2026-08-12  
> Method: 40+ probes covering the kernel, container, processes, network, storage, permissions, and filesystem semantics were run inside the sandbox, supplemented by comparison with public materials.  
> Scope of merge: This report combines the Kimi Sandbox Technical Research Report and the Kimi Sandbox FUSE Filesystem (fuse.portal) Deep-Dive Report. It uses the overall architecture as its spine while retaining the detailed FUSE gateway evidence, semantics matrix, performance tests, and security analysis.  
> Evidence boundary: Items marked **[Observed]** are direct observations from inside the sandbox; items marked **[Inferred]** are reasoned conclusions based on those observations. The implementation of services outside the sandbox boundary cannot be observed from inside and is not asserted here.

---

## 1. Executive Summary

Kimi's code-execution sandbox is a **containerd container** running on **Kubernetes**. The host kernel is a customized Alibaba Cloud LifseaOS kernel; the container provides a Debian 12 userspace and runs as a non-root user (uid=999), with an approximate quota of 2 CPU cores, 4 GB of memory, and 30 GB of disk.

The sandbox's temporary workspace resides in the containerd overlayfs root layer and is destroyed with the session. Cross-session persistence is provided by a custom FUSE file gateway, `fuse.portal`. Its FUSE daemon runs as root outside the sandbox container, holds the privileges required for mounting, and projects the filesystem into the sandbox through Kubernetes shared mount propagation. Its backend connects to cloud storage at `agent-gw.kimi.com` and isolates data by session.

The key architectural decision is not to grant mount privileges to sandbox code, but to **externalize privilege entirely**: the sandbox has no mount capability, no `/dev/fuse`, and no `CAP_SYS_ADMIN`; untrusted code remains an ordinary filesystem client. On `/mnt/agents`, the data-plane POSIX semantics are largely usable, but metadata semantics are intentionally simplified: chmod and utime are silently ignored, symbolic links, hard links, and xattrs are unavailable, statfs does not expose capacity information, and each file has a hard limit of 100 MiB.

The performance profile reflects the same trade-off: metadata operations are fast (`stat` median latency around 33µs), while the data plane is generally slower than the local disk (roughly 35–187 MB/s sequential writes and about 92 MB/s cold reads). A fast `fsync` return does not mean the data has reached cloud persistence. Overall, `fuse.portal` is best understood as a **cloud-object-storage client disguised as a local directory plus a security-policy enforcement point**. It is optimized for isolation, quotas, and control—not for the throughput and complete POSIX compatibility expected of a general-purpose production filesystem.

## 2. Infrastructure Layer [Observed]

| Dimension | Observation | Evidence |
| :--- | :--- | :--- |
| Container orchestration | Kubernetes, QoS class `burstable` | cgroup path `/kubepods/burstable/pod<uuid>/...` |
| Container runtime | containerd with an overlayfs snapshotter | Root mount lowerdirs come from `io.containerd.snapshotter.v1.overlayfs`; 400+ read-only image layers are observable |
| Host kernel | `5.10.134-18.0.11.lifsea8.x86_64` | `uname -a`; “lifsea” points to Alibaba Cloud's container-optimized LifseaOS kernel [Inferred: underlying infrastructure is Alibaba Cloud] |
| Container userspace | Debian GNU/Linux 12 (bookworm) | `/etc/os-release` |
| Init system | s6, with PID 1 as `s6-svscan` | Process list; s6 supervises kasmvnc, kernel-server, sshd, socat, browser-guard, and other services |
| Hostname | `k2087191046178906117`, assigned per instance | `hostname` |

## 3. Resource Quotas [Observed]

| Resource | Quota | Notes |
| :--- | :--- | :--- |
| CPU | 2 cores | `nproc` |
| Memory | 4.0 GiB, no swap | `free -h` |
| Root disk | 30 GB overlay, approximately 5.5G used | `df -h` |
| `/tmp` | Located in the overlay root layer | Temporary storage; lost when the container is destroyed |
| `/mnt/agents` | Independent FUSE mount | Persistent across sessions; 100 MiB per-file limit |

## 4. Services Inside the Container [Observed + Inferred]

The sandbox is not a bare container. It is a complete environment for AI-agent workloads. The following components are visible in `ps aux`:

| Component | Form | Purpose [Inferred] |
| :--- | :--- | :--- |
| `kernel_server.py` (port 8888, `kimi` user) | Python service | Code-execution kernel gateway using the Jupyter protocol; entry point for the agent's shell/IPython tools |
| `ipykernel_launcher` | Jupyter kernel | Persistent Python session |
| `browser_guard.py` + Chromium 150 | Headless browser, `--no-sandbox`, single process | Web access, screenshots, and browser automation; egress through `--proxy-server=10.86.13.73:5900` |
| `Xvnc` (KasmVNC, `:99`, 1920x1080) | Virtual display + VNC | GUI rendering for computer-use capabilities |
| `socat TCP-LISTEN:9223 → localhost:9222` | Port forwarding | Exposes the Chrome DevTools Protocol |
| `sshd` + multiple `sftp-server` sessions | SSH/SFTP | File-transfer channel between the platform and sandbox; a second data path alongside FUSE |

## 5. Network [Observed + Inferred]

- **Outbound access is available**: `https://pypi.org` and `https://www.baidu.com` both returned 200; ICMP could reach `8.8.8.8` with an RTT of approximately 200 ms, clearly passing through a gateway or proxy.
- **No explicit proxy variables**: The shell environment had no `HTTP_PROXY`, but Chromium was explicitly configured to use `10.86.13.73:5900`. This indicates a transparent egress gateway, with browser traffic separately controlled [Inferred: the egress likely applies content auditing and domain policies].
- **DNS**: Cluster CoreDNS was configured with `nameserver 192.168.0.10` and search domains including `*.svc.cluster.local`, consistent with a typical Kubernetes Pod network.
- Some sites, such as `ifconfig.me`, did not respond, consistent with a whitelist or audit-oriented egress gateway [Inferred].

## 6. Storage Architecture Overview

The sandbox exposes two storage paths with very different purposes:

| Path | Implementation | Persistence | Characteristics |
| :--- | :--- | :--- | :--- |
| `/` (including `/tmp` and `/home`) | Host-local containerd overlayfs | Destroyed at the end of the session | Local-disk performance and full POSIX semantics; approximately 191 MB/s sequential writes and 6.8 GB/s cached reads |
| `/mnt/agents` | Custom `fuse.portal` FUSE gateway | Persistent across sessions | Restricted POSIX semantics; no symbolic links, hard links, or xattrs; 100 MiB per-file limit; approximately 35–187 MB/s writes |

The following functional areas are observable under `/mnt/agents` [Observed]:

- `upload/`: user-uploaded content, read-only;
- `output/`: deliverables visible to the user;
- `.store/`: session metadata;
- `.tmp/`, `deploy/`, and `images/`: runtime and delivery-related directories;
- `.agent-gw.json`: an injected read-only configuration file with mode 444, containing `base_url: https://agent-gw.kimi.com/coding` and a session-issued `kimi_chat_id` credential (the key is redacted).

Use `/tmp` for caches, build intermediates, and reproducible data. Use `/mnt/agents` for inputs, outputs, and small-to-medium deliverables that must survive across sessions. Do not treat `/mnt/agents` as a complete POSIX production filesystem: do not rely on chmod, mtime, xattrs, links, statfs, or writes to a single file larger than 100 MiB.

## 7. FUSE Technical Background

FUSE (Filesystem in Userspace), proposed by Miklos Szeredi in 2001, moves filesystem logic from kernel space into user space and consists of two parts[^2]:

- **Kernel module `fuse.ko`**: Attached below the VFS and converts system calls such as `open`, `read`, and `write` into FUSE protocol requests;
- **Userspace daemon**: Reads requests from the `/dev/fuse` character device, performs the filesystem operation in userspace, writes the result back, and allows the kernel to wake the waiting application.

The protocol is a client-server model: **the kernel is the client and the daemon is the server**. Each request begins with a `fuse_in_header` containing the length, opcode, request ID, node ID, and caller uid/gid/pid. The daemon responds with a `fuse_out_header` containing the length, error code, and request ID[^1]. At mount time, `FUSE_INIT` negotiates the protocol version and parameters such as `max_readahead`, `max_write`, and the timestamp precision `time_gran`[^1].

~~~text
Application (cp/cat/python) → system call → VFS → fuse.ko → /dev/fuse → userspace daemon → arbitrary backend
~~~

The cost is additional context switching for each I/O operation. The benefits are that no kernel filesystem implementation is required, a daemon crash generally does not bring down the kernel, and the backend can be anything—sshfs, s3fs, and JuiceFS all use this model[^2]. In rootless scenarios, Linux has supported mounting FUSE inside a user namespace since kernel 4.18[^3].

## 8. `fuse.portal` Deployment Model [Fully Observed]

### 8.1 The daemon runs outside the sandbox

The complete `ps aux` process list inside the sandbox contains no FUSE process. The `/dev/fuse` device node is absent and `fusermount` is not installed. However, the mount parameters contain `user_id=0,group_id=0`, indicating that the daemon runs as **root** in a trusted domain outside the sandbox, most likely on the host or in a privileged sidecar.

### 8.2 The mount enters the container through mount propagation

`/proc/self/mountinfo` contains:

~~~text
4341 4340 0:89 / /mnt/agents rw,nosuid,nodev,relatime master:315 - fuse.portal portal rw,user_id=0,group_id=0,allow_other,max_read=1048576
~~~

`master:315` indicates that the mount belongs to a shared-mount peer group and is a subordinate copy: the mount is established externally and then delivered into the container's mount namespace through mount propagation. This is consistent with Kubernetes' typical `mountPropagation: HostToContainer` configuration.

### 8.3 `allow_other` and mount flags

By default, FUSE allows access only to the mounting user. For a root-mounted filesystem to be readable and writable by the sandbox user with uid=999, `allow_other` must be explicitly enabled. At the same time, `max_read=1048576` indicates a negotiated per-read limit of 1 MiB, while `nosuid,nodev` prevents files written into the mount from becoming setuid or device-based privilege-escalation carriers. Together, these flags show a mount configured for cross-identity sharing with a reduced privilege surface.

## 9. POSIX Semantics Matrix [Fully Observed]

| POSIX area | Observed result | Assessment |
| :--- | :--- | :--- |
| `open/read/write/close/lseek` | Works, including append and random writes; write-back cache reaches approximately 1.1 GB/s within the quota | ✅ |
| `mkdir/rmdir/rename/unlink` | Works, including directory rename and recursive deletion | ✅ |
| `mmap` (read/write) | Write and read-back verification passed | ✅ |
| `flock` | Works; cross-client validity is unknown | ✅ |
| Read-after-write consistency | Immediately readable from the same mount point | ✅ |
| Concurrent append (4 threads × 50 lines) | All 200 lines present, with no loss | ✅ |
| Filename length | A 300-character filename can be created, exceeding POSIX `NAME_MAX=255` | ✅, superset |
| `chmod/chown` | Silently ignored: returns success but has no effect; files remain fixed as `root:root`, 644/755 | ❌ |
| `utimensat` | Silently ignored: mtime/atime remain at the write time, with only one-second precision | ❌ |
| symlink | `Operation not supported` | ❌ |
| hard link | Fails with ENOENT rather than the conventional EPERM/ENOSYS | ❌ |
| xattr | `ENODATA` | ❌ |
| `statfs` | All zeros; capacity/inode information is unavailable and `df` reports 0.0K | ❌ |
| Sparse files | A write after seeking returns `EIO` | ❌ |
| Per-file limit | Exactly 100 MiB (104,857,600 bytes); writes beyond the limit return `EIO`; no equivalent total-capacity limit was observed | ❌, quota constraint |
| File ownership | Always `root:root`, regardless of creator | ❌, synthetic metadata |
| `fsync` | Returns in approximately 0.1 ms; this does not mean data has reached the durable layer | ⚠️ weakened semantics |
| `inotify` | Local operations generate events; external changes from other sessions are not pushed | ⚠️ |

### 9.1 Compatibility conclusion

`fuse.portal` is a **read/write-oriented POSIX subset**. Its data plane—reads, writes, rename, mmap, and locking—is broadly usable; its metadata plane is extensively missing or synthetic. By comparison, the production-grade cloud filesystem JuiceFS passes all 8,789–8,813 pjdfstest cases and provides close-to-open consistency, atomic rename, continued reads through an already-open unlinked file, fallocate/punch-hole support, xattrs, flock, and fcntl record locks[^4][^5]. It also reports a pass rate above 99% across approximately 1,270 filesystem-related LTP tests[^6]. If `fuse.portal` were run through pjdfstest, it would be expected to fail many metadata- and quota-related cases. That is better understood as an intentional security and simplification choice than as a defect in a general-purpose filesystem implementation.

### 9.2 Toolchain risks

Silently pretending that chmod and utime succeeded is more dangerous than returning an error. Tools that rely on mtime or permission metadata—`rsync`, `cp -a`, tar, and git—may silently produce incorrect results. Do not treat timestamps, permission bits, or file ownership as authoritative when using these tools on `/mnt/agents`.

## 10. Performance Tests and Comparison with JuiceFS

### 10.1 portal versus local overlay

The test environment was a 2-core / 4 GB sandbox; `/tmp` overlay was used as the local-disk comparison.

| Metric | `fuse.portal` | `/tmp` overlay | Difference |
| :--- | :--- | :--- | :--- |
| Sequential write throughput | 35–187 MB/s, highly variable | 191 MB/s | Approximately 1–5× slower |
| Sequential read (cold) | 92 MB/s | — | — |
| Sequential read (page-cache hit) | 1.3 GB/s | 6.8 GB/s | Approximately 5× slower |
| Small-file create + write (median / p99) | 383µs / **41ms** | 33µs / 92µs | Median approximately 11.6× slower; p99 approximately 450× |
| `stat` (median) | **33µs** | 3µs | Approximately 11× slower |
| Small-file read (median) | 153µs | 16µs | Approximately 9.6× slower |

Sub-millisecond median latency suggests that the daemon and sandbox are on the same host and that metadata is probably held in local memory. The occasional 41 ms small-file tail suggests that some operations cross into the remote path. An `fsync` time of only about 0.1 ms supports the hypothesis of **local buffering plus asynchronous upload**. Important files should therefore be explicitly closed after writing; if the session terminates abruptly, the last writes may not have reached cloud persistence.

### 10.2 Order-of-magnitude comparison with public JuiceFS data

JuiceFS's official comparison test used an AWS c5d.18xlarge instance (72 CPUs, 144 GB RAM, and local NVMe cache) with an S3 backend, using fio 3.1 to compare EFS and Goofys[^7]. Its performance guide also states that JuiceFS sequential reads and writes substantially outperform EFS and exceed commonly used EBS throughput, while small-file writes are not fast because every write must be persisted to object storage, adding a fixed object-storage API cost of approximately 10–30 ms[^8]. On the metadata side, JuiceFS uses KV engines such as Redis and TiKV and provides mdtest/fio benchmarking methods[^9].

| Dimension | portal (this test) | JuiceFS (public data) | Order-of-magnitude assessment |
| :--- | :--- | :--- | :--- |
| Large-file throughput | 35–187 MB/s writes, 92 MB/s cold reads | Official tests substantially outperform EFS/Goofys; cache hits can reach GB/s scale[^7] | portal is roughly an order of magnitude slower |
| Metadata latency | `stat` median **33µs**, with strong local-metadata characteristics | Each operation generally involves a network RPC to the metadata engine; small-file writes are affected by 10–30 ms object-storage overhead[^8] | portal can be 1–2 orders of magnitude faster |
| Small-file creation | 383µs median, 41ms p99 | Constrained by object-storage write overhead[^8] | portal wins on the median; tails are comparable |
| Per-file limit | Hard 100 MiB limit | No practical equivalent limit | Product-policy difference; not directly comparable |

This is not simply a question of which system is faster. The target workloads differ: JuiceFS spends its engineering budget on data chunking, parallel object-storage transfer, and NVMe read caching to optimize “using object storage as production storage”; portal spends its budget on isolation, quotas, and control to optimize “giving untrusted code a secure cloud file drawer.”

> **Calibration note:** JuiceFS data comes from vendor documentation using a 72-core machine and a separate metadata engine; portal data comes from a single 2-core/4 GB sandbox. Except for order-of-magnitude conclusions, these values should not be divided directly to produce precise comparisons.

## 11. Security Model: Externalized Privilege

### 11.1 Privilege separation [Fully Observed]

| Check | Result |
| :--- | :--- |
| Runtime user | `kimi`, uid=999, non-root |
| Effective capabilities | `CapEff = 0`; none held |
| Capability bounding set | `a80425fb`, Docker's default set, excluding `CAP_SYS_ADMIN` |
| `mount -t tmpfs` | Fails with `must be superuser` |
| `sudo` | Requires a password; no escalation path observed |
| `/dev/fuse` | Absent |
| `fusermount` / `fusermount3` | Not installed |
| seccomp | The probe shell showed `Seccomp: 0`; no filter was observed |

### 11.2 Security-boundary implementation

The genuinely privileged parts of FUSE are `mount(2)`—which normally requires `CAP_SYS_ADMIN` or a setuid fusermount helper—and opening `/dev/fuse`. Reading and writing an already-mounted directory does not require privilege. Kimi moves both privileged elements outside the sandbox:

| Evidence | Meaning |
| :--- | :--- |
| No FUSE process, `/dev/fuse`, or `fusermount` inside the sandbox | The daemon and protocol channel are unreachable from the sandbox |
| `master:315` propagated mount plus daemon `user_id=0` | The privileged component runs as root outside the sandbox |
| Sandbox process `CapEff=0`, bounding set excludes `CAP_SYS_ADMIN` | `mount -t tmpfs` fails in practice |
| Mount forced to `nosuid,nodev` | Files written into the mount cannot become setuid or device-based privilege carriers |
| Daemon disables links, weakens metadata, and enforces the 100 MiB limit | Protects against path escape, metadata abuse, and resource abuse |

The true trust boundary is **sandbox code acting as a client against the daemon**. Malicious filenames, unusual flags, and concurrent races can all reach the daemon through the FUSE protocol; the daemon must defend against hostile input itself. The blast radius is constrained to the session-isolated data plane, with credentials issued per `kimi_chat_id` and injected through a read-only configuration.

### 11.3 Residual attack surface [Observed + Inferred]

- **Unprivileged user namespaces are not disabled**: after `unshare -Urm`, a tmpfs can be mounted inside the user namespace. A user namespace is an isolation scope and normally keeps the effect within itself, but user namespaces have historically been a high-risk area for kernel privilege-escalation vulnerabilities. Keeping them enabled is likely necessary for Chromium's sandboxing.
- **The user-namespace FUSE path is not practically available**: although Linux has supported FUSE mounts inside user namespaces since 4.18[^3], the sandbox has no `/dev/fuse`, and the device file cannot be created from inside the user namespace.
- **No seccomp reduction was observed**: the full system-call surface is exposed to the non-root user; the boundary relies mainly on the non-root identity, the capability bounding set, namespace isolation, and the absence of device exposure.
- **Session credentials are readable**: the API key in `.agent-gw.json` is readable by sandbox code. Mitigations are per-session credentials, read-only injection, and limiting the blast radius to the current session's data.

## 12. Architecture Overview

~~~text
┌────────────────────── Kubernetes cluster (Alibaba Cloud LifseaOS host) ──────────────────────┐
│                                                                                              │
│  ┌── Pod (burstable) ─────────────────────────────────────────────────────────────────────┐  │
│  │ Container (containerd / Debian 12 / 2C4G / s6 init / kimi uid=999)                   │  │
│  │                                                                                        │  │
│  │ kernel_server:8888  ipykernel  Chromium (proxy egress)  Xvnc :99  sshd/sftp          │  │
│  │                                                                                        │  │
│  │  / (overlay, ephemeral)      /mnt/agents ── propagated mount (master:315) ──┐          │  │
│  └─────────────────────────────────────────────────────────────────────────────│──────────┘  │
│                                                                                 │             │
│                         ┌── fuse.portal daemon (root, outside sandbox) ◄──────┘             │
│                         │   Holds /dev/fuse; enforces quotas, policy, and audit             │
│                         └──────────────────────┬──────────────────────────────────────────  │
└───────────────────────────────────────────────│─────────────────────────────────────────────┘
                                                ▼
                         agent-gw.kimi.com cloud storage (isolated by kimi_chat_id)
~~~

## 13. Design Trade-offs

| Alternative | Why it was not preferred |
| :--- | :--- |
| K8s PV/PVC backed by cloud disk | One-to-one block-device attachment is a poor fit for large numbers of short-lived Pods requiring second-scale attach/detach; the data plane is also harder to control centrally |
| NFS/SMB | Requires a kernel client and reachable storage cluster, with no built-in per-session authentication and business-policy hooks |
| 9p/virtiofs | Tied to a particular virtualization form and likewise lacks business-level quota and audit hooks |
| **Custom FUSE gateway** | External daemon creates the security boundary; object storage provides elasticity; quotas, isolation, and auditing can be implemented in userspace; portable across host types |

**Cost:** Data performance is worse than local disk, POSIX metadata semantics are incomplete, and `fsync` does not equal cloud persistence. For workloads involving AI-generated session artifacts from kilobytes to tens or hundreds of megabytes, this cost is acceptable.

## 14. Limitations and Open Questions

1. Pod scheduling policy, the image build chain, and the daemon's exact process placement (host or sidecar) cannot be observed from inside the container.
2. The cloud-storage backend type—object storage versus block storage plus a custom protocol—can only be inferred from behavior and has not been confirmed.
3. The strength of cross-session isolation, gateway auditing policy, and the complete egress allowlist cannot be verified internally.
4. No destructive or adversarial tests were performed; the research consisted of read-only probes and routine file operations.
5. The JuiceFS comparison uses public benchmarks on substantially different hardware and scale and should be treated only as an order-of-magnitude reference.

## 15. Appendix: Key Probes and Excerpts of Raw Output

### 15.1 Mount information

~~~bash
$ grep portal /proc/self/mountinfo
4341 4340 0:89 / /mnt/agents rw,nosuid,nodev,relatime master:315 - fuse.portal portal \
  rw,user_id=0,group_id=0,allow_other,max_read=1048576
~~~

### 15.2 100 MiB per-file limit

~~~bash
$ dd if=/dev/zero of=big2.bin bs=1M count=512 conv=fdatasync
dd: error writing 'big2.bin': Input/output error
100+0 records out
104857600 bytes (105 MB, 100 MiB) copied, 2.56423 s, 40.9 MB/s
~~~

### 15.3 Metadata semantics

~~~bash
# chmod is silently ignored
$ chmod 755 a.txt && stat -c "%a" a.txt
644

# utime is silently ignored: mtime remains the write time rather than 1000000000
$ python3 -c "import os; os.utime('d.txt',(1000000000,1000000000)); print(os.stat('d.txt').st_mtime)"
1786461181.0

# Timestamp precision is only one second
$ stat -c "mtime:%y" a.txt
mtime:2026-08-11 23:11:56.000000000 +0800

# A 300-character filename succeeds, exceeding NAME_MAX=255
$ python3 -c "open('x'*300,'w')"
~~~

### 15.4 Injected single-file configuration (key redacted)

~~~bash
$ cat /mnt/agents/.agent-gw.json
{"api_key":"sk-kimi-<REDACTED>","base_url":"https://agent-gw.kimi.com/coding","kimi_chat_id":"<REDACTED>"}
~~~

## References

[^1]: [fuse(4) — Linux manual page](https://man7.org/linux/man-pages/man4/fuse.4.html), covering the FUSE kernel protocol's `fuse_in_header`, `fuse_out_header`, and `FUSE_INIT`.
[^2]: [The Design Journey of FUSE: From Kernel-Space to User-Space File Systems — JuiceFS Blog](https://juicefs.com/en/blog/engineering/design-fuse-kernel-user-space).
[^3]: [JuiceFS mount fails inside unprivileged user namespace — issue #6988](https://github.com/juicedata/juicefs/issues/6988), concerning FUSE support in user namespaces since Linux 4.18.
[^4]: [JuiceFS POSIX compatibility, Community Edition](https://juicefs.com/docs/zh/community/posix_compatibility/), covering pjdfstest, close-to-open consistency, atomic rename, fallocate, xattrs, and locking semantics.
[^5]: [JuiceFS POSIX compatibility, Cloud Service](https://juicefs.com/docs/zh/cloud/reference/posix_compatibility/), covering pjdfstest and LTP results.
[^6]: [JuiceFS POSIX compatibility in practice](https://blog.csdn.net/gitblog_00795/article/details/151411908), covering the LTP filesystem-test pass rate.
[^7]: [JuiceFS comparison with EFS and Goofys](https://juicefs.com/docs/zh/cloud/benchmark/efs_goofys_comparison/), using fio 3.1, c5d.18xlarge, and S3.
[^8]: [JuiceFS performance evaluation guide](https://juicefs.com/docs/zh/community/performance_evaluation_guide/), discussing the fixed object-storage overhead for small-file writes.
[^9]: [JuiceFS metadata-engine benchmark](https://juicefs.com/docs/zh/community/metadata_engines_benchmark/), describing mdtest/fio benchmarking methods.
