# OpenCode Autopilot — 设计计划书 v3.1

## 1. 项目定位

**名称**：opencode-autopilot
**定位**：为 OpenCode 提供一键切换的全自主 AI 编程沙箱。基于 btrfs subvolume snapshot 实现块级 COW 全系统隔离。

**核心哲学**：
- **零内核改动**：只做 plugin，不碰 opencode 源码
- **沙箱即丢弃**：snapshot 删除即一切消失，第二天人工 screening
- **全系统 COW**：btrfs 原生 snapshot，无需 FUSE、无需 overlay、无需 namespace
- **fork 继承**：session fork 时从父 snapshot 创建，保留上下文

---

## 2. 架构

```
Tab → autopilot:
  chat.message(agent="autopilot") → create()
  
  mount -t btrfs -o subvolid=${AUTOPILOT_BTRFS_SUBVOLID:-5} /dev/nvme0n1p2 /dev/shm/oc-btrfs
  btrfs subvolume snapshot /dev/shm/oc-btrfs/@rootfs /dev/shm/oc-btrfs/@ap-<id>
  → snapshot 是完整根文件系统的可写 COW 副本

tool.execute.before:
  args = JSON.parse(JSON.stringify(args))   # 深拷贝隔离
  modify sandboxArgs → redirect to snapshot/
  output.args = sandboxArgs                 # 原始 args 不变（transcript 干净）

bash:
  echo <base64_script> | base64 -d | chroot snapshot/ /bin/bash -s

Tab → build:
  chat.message(agent="build") → deactivate() → 停止拦截，snapshot 保留

退出 opencode:
  process.exit/SIGTERM → discardAll() + umount
```

---

## 3. 工具拦截清单

| # | Tool | 策略 |
|---|------|------|
| 1 | **`bash`** | `printf base64 | base64 -d | chroot snapshot/ bash -s` |
| 2 | **`write`** | filePath → snapshot/ |
| 3 | **`read`** | filePath → snapshot/ |
| 4 | **`edit`** | filePath → snapshot/ |
| 5 | **`glob`** | path → snapshot/ |
| 6 | **`grep`** | path → snapshot/ |
| 7 | **`apply_patch`** | `*** Add/Update/Delete File`、`*** Move to`、diff paths → snapshot/ |
| 8 | **`lsp`** | filePath → snapshot/ |
| 9 | **`task`** / **`question`** / **`skill`** | 不拦截（passthrough） |

**关键**：`tool.execute.before` 创建 `sandboxArgs` 深拷贝，原始 `args` 对象不修改 → transcript 显示干净路径。

---

## 4. Fork 继承

当 opencode session 被 fork 时，新 session 的 autopilot snapshot 从**父 session 的 snapshot** 创建，而非从根。

```
Session A (autopilot):
  snapshot A: @ap-ses_1f-xxx
  → AI 修改文件

Fork → Session B:
  chat.message(variant="fork") → 检测 parentID
  snapshot B: @ap-ses_1g-yyy ← 从 snapshot A 创建
  → 继承 Session A 的所有修改
  → COW 隔离：Session B 的修改不影响 A
```

---

## 5. 方案演进

| 版本 | 方案 | 问题 |
|---|---|---|
| v1 | kernel overlay + rbind + chroot | btrfs 子卷不支持 overlay `/` |
| v2 | fuse-overlayfs lowerdir=/ | FUSE 镜厅递归 / 虚拟文件系统不稳定 |
| **v3** | **btrfs subvolume snapshot** | **需要 root** |
| v3.1 | + fork 继承 + 深拷贝隔离 + base64 bash | 无感隔离 |

---

## 6. 安全审计清单

| 风险 | 防护 |
|------|------|
| `destroy()` 误删 @rootfs | 路径前缀检查 `startsWith(TOP_MNT + "/@ap-")` |
| 路径注入 | ID 格式校验 `^[a-z0-9_-]+$` |
| 路径遍历逃逸 | `path.resolve` + `startsWith` 边界校验 |
| 内部命令拼接 | btrfs/mount 管理命令使用 `execFileSync(command, args)` |
| symlink 父目录逃逸 | 检查目标及最近存在父目录的 `realpathSync` |
| mount 到错误设备 | `findmnt` 二次验证 |
| 非 root 执行 | `process.getuid()` 前置拒绝 |
| `@rootfs` 命名假设 | 动态 `btrfs subvolume show /` 检测 |
| bash 命令注入 | base64 编码管道，无变量展开 |
| 物理硬件访问 | chroot 中可 mknod 创建设备节点 → 需配合 seccomp/namespace（见 9.5） |

> **安全边界声明**：本架构通过 btrfs COW 隔离**文件系统修改**，但无法阻止 root 权限下的**设备节点创建**（mknod）。适用场景为"可信 AI 协作者的隔离执行"，而非"不可信代码沙箱"。

---

## 7. 状态机

```
OFF ──Tab→ autopilot──→ ON
  ↑                      │
  │                      ├─ ensureTopLevel (mount btrfs subvolid=5)
  │                      ├─ btrfs subvolume snapshot @rootfs → @ap-<id>
  │                      ├─ hooks intercept → redirect to snapshot/
  │                      ├─ agent works autonomously
  │                      ├─ fork → snapshot from parent snapshot
  │                      ├─ compaction → autocontinue
  │                      │
  │                      ▼
  └──Tab→ build/plan──→ OFF
                          ├─ deactivate() → hooks stop intercepting
                          ├─ snapshot KEPT for review
                          │
                          exit ──→ discardAll() + umount
```

---

## 8. 文件结构

```
autopilot/
├── .opencode/prompts/autopilot.txt
├── src/
│   ├── index.ts       # 插件入口（fork 检测 + 状态管理）
│   ├── sandbox.ts     # btrfs snapshot + 安全校验 + fork 继承
│   └── hooks.ts       # tool.execute.before/after 拦截
├── dist/
├── package.json + tsconfig.json
├── README.md + PLAN.md
└── .gitignore
```

---

## 9. 关键设计决策

### 9.1 为什么是 btrfs snapshot 而不是 FUSE？

FUSE `lowerdir=/` 面临两个致命问题：
- **镜厅递归**：merged/ 在 lowerdir 树下，FUSE 遍历自身 → VFS 死循环
- **虚拟文件系统**：/proc、/sys、/dev 是内核合成文件系统，FUSE 无法正确处理

btrfs snapshot 是块级操作——文件系统元数据级快照，不经过 VFS 路径遍历，天然免疫这些问题。

### 9.2 为什么沙箱不合并？

**执行和合入解耦**。夜间 AI 在 snapshot 中自由执行，第二天人类选择性合入。

### 9.3 为什么需要 root？

btrfs subvolume 操作需要 `CAP_SYS_ADMIN`。这是 btrfs 的内核安全策略，不可绕过。

### 9.4 为什么 transcript 需要深拷贝隔离？

如果 hook 直接修改 `output.args`，transcript 会记录 snapshot 内部路径（`/dev/shm/oc-btrfs/@ap-xxx/...`）。AI 从 transcript 看到这些路径后会模仿，导致：
- 路径双重嵌套（`@ap-xxx/dev/shm/...`）
- AI 手动构造 chroot 命令
- 命令嵌套失败

通过 `JSON.parse(JSON.stringify(args))` 深拷贝 + 恢复原始 `input.args`，transcript 始终显示 `/root/...` 干净路径。

### 9.5 安全边界：为什么不是完全沙箱？

本架构隔离的是**文件系统状态**，不是**内核资源访问**：

| 层面 | 隔离 | 说明 |
|------|------|------|
| 文件系统修改 | ✅ COW | snapshot 删除即回滚 |
| 进程/网络 | ❌ 共享 | 与宿主同一 PID/network namespace |
| 设备访问 | ❌ 共享 | chroot 中可 `mknod` 创建设备节点访问物理硬件 |

**适用场景**：可信 AI 的隔离执行（夜间运行、白天审查）。
**不适用场景**：运行不可信代码或对抗性 AI。

如需完全隔离，需叠加：
- `unshare --mount --pid --net`（mount/pid/network namespace）
- seccomp-bpf（限制 mknod 等 syscall）
- cgroup（资源限制）

但本插件明确选择**不**走这条路——见 9.1（零 namespace）的设计哲学。

---

*文档版本：v3.1*
*日期：2026-05-09*
