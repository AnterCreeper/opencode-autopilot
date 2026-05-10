# OpenCode Autopilot — 设计计划书 v4.0

## 1. 项目定位

**名称**：opencode-autopilot
**定位**：为 OpenCode 提供一键切换的全自主 AI 编程沙箱。基于 btrfs subvolume snapshot + bwrap namespace 实现块级 COW 全系统隔离。

**核心哲学**：
- **绝对透明**：AI 看到真实路径，沙箱无感
- **沙箱即丢弃**：snapshot 删除即一切消失，第二天人工 screening
- **全系统 COW**：btrfs 原生 snapshot，无需 FUSE、无需 overlay
- **namespace 隔离**：bwrap 提供 mount/pid 隔离，可配置叠加
- **fork 继承**：session fork 时从父 snapshot 创建，保留上下文

---

## 2. 架构

```
Tab → Pilot:
  chat.message(agent="pilot") → create()
  
  mount -t btrfs -o subvolid=5 /dev/<blkdev> $SNAPSHOT_DIR
  btrfs subvolume snapshot $SNAPSHOT_DIR/@rootfs $SNAPSHOT_DIR/@ap-<id>
  spawn bwrap (常驻 bash，hold namespace)
  → snapshot 是完整根文件系统的可写 COW 副本

tool.execute.before (文件工具):
  sandboxArgs = { ...args }                        # 浅拷贝隔离
  sandboxArgs.filePath → toSandboxPath             # 路径改写至 snapshot
  args 不变 → transcript 干净                      # opencode-fork 内部修正

bash (bwrap 内):
  command → printf|base64|nsenter -t PID -m [-p] bash -s
  → bash tool 原生 streaming/cancel/exit code
  → 无需 per-command bwrap 启动，nsenter 进入已有 namespace

Tab → Build:
  chat.message(agent="build") → deactivate() → 停止拦截，bwrap 继续跑

退出 opencode:
  process.exit/SIGTERM → discardSession() → killBwrap
  → snapshot 保留，手动 npm run cleanup
```

---

## 3. 工具拦截清单

| # | Tool | 策略 |
|---|------|------|
| 1 | **`bash`** | `printf\|base64\|nsenter -t PID bash -s` |
| 2 | **`write`** | filePath → toSandboxPath |
| 3 | **`read`** | filePath → toSandboxPath |
| 4 | **`edit`** | filePath → toSandboxPath |
| 5 | **`glob`** | path → toSandboxPath |
| 6 | **`grep`** | path → toSandboxPath |
| 7 | **`apply_patch`** | `*** Add/Update/Delete File`、`*** Move to`、diff paths → toSandboxPath |
| 8 | **`lsp`** | filePath → toSandboxPath |
| 9 | **`task`** / **`question`** / **`skill`** | 不拦截（passthrough） |

---

## 4. Fork 继承

当 opencode session 被 fork 时，新 session 的 snapshot 从**父 session 的 snapshot** 创建，而非从根。

```
Session A (Pilot):
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
| v3 | btrfs snapshot + chroot + path rewriting | AI 看到 snapshot 路径，transcript 泄漏 |
| v3.1 | + fork 继承 + 深拷贝隔离 + base64 bash | 多防线但架构冗余 |
| **v4** | **bwrap spawn + pid namespace + 路径透明** | AI 绝对透明，隔离可配置 |

---

## 6. 安全模型

| 风险 | 防护 |
|------|------|
| 文件系统修改 | btrfs COW snapshot |
| PID 误杀 | bwrap --unshare-pid（默认） |
| 路径注入 | `path.resolve` + `startsWith` 边界校验 |
| symlink 逃逸 | `realpathSync` 二次验证 |
| mount 到错误设备 | `findmnt` 二次验证 |
| 非 root 执行 | `process.getuid()` 前置拒绝 |
| 内部命令拼接 | `execFileSync(command, args)` |

**额外隔离选项**（通过 `AUTOPILOT_BWRAP_FLAGS`）：

| flag | 效果 |
|------|------|
| `--unshare-net` | 网络隔离 |
| `--unshare-uts` | hostname 隔离 |
| `--unshare-ipc` | IPC 隔离 |

---

## 7. 状态机

```
OFF ──Tab→ Pilot──→ ON
  ↑                    │
  │                    ├─ ensureTopLevel (mount btrfs)
  │                    ├─ btrfs subvolume snapshot @rootfs → @ap-<id>（首次）
  │                    ├─ spawn bwrap（常驻 namespace holder）
  │                    ├─ hooks intercept → toSandboxPath (file tools) / executeInBwrap (bash)
  │                    ├─ fork → snapshot from parent snapshot
  │                    │
  │                    ▼
  └──Tab→ Build/Plan──→ OFF
                         ├─ deactivate() → hooks stop intercepting
                         ├─ bwrap 进程继续跑（不 kill）
                         ├─ snapshot KEPT for review
                         │
                         exit ──→ discardSession() → killBwrap
                                   → snapshot 保留（手动 npm run cleanup）
```

---

## 8. 配置

```bash
# snapshot 存储目录
export AUTOPILOT_SNAPSHOT_DIR=/dev/shm/oc-btrfs

# bypass 白名单（逗号分隔）—— bwrap --bind 直通宿主机
export AUTOPILOT_BYPASS_PREFIXES=/root/.opencode/

# bwrap 额外隔离选项
export AUTOPILOT_BWRAP_FLAGS="--unshare-pid --unshare-net"

# 调试模式（显示原始路径）
export AUTOPILOT_DEBUG=1
```

---

## 9. 关键设计决策

### 9.1 为什么 bwrap 替代 chroot？

chroot + path rewriting 让 AI 在 transcript 中看到 snapshot 路径，引起困惑和路径嵌套。bwrap 在 mount namespace 内挂载 snapshot 为 `/`，AI 感知到的文件系统与宿主机完全一致——绝对透明。

### 9.2 为什么 nsenter 而不是 stdin/stdout pipe？

stdin/stdout pipe 方案需要修改 opencode-fork 的 bash.ts（ChildProcessSpawner 层面），侵入性过大。nsenter 方案在 before hook 中同步执行命令，结果通过 base64 echo 回传，零侵入 at fork 层面。代价是丢失实时流式输出——适合自主无人值守模式。后续可升级为 pipe 方案。

### 9.3 为什么 snapshot 不自动删除？

审查流程：醒来 → 切换到 Build → 审查 snapshot 改动 → 手动 `npm run cleanup` 删除。自动删除违背"审查后合入"的哲学。

### 9.4 为什么 transcript 需要深拷贝隔离？

如果 hook 直接修改 `output.args`，transcript 会记录 snapshot 内部路径。AI 看到后会模仿，导致路径双重嵌套。opencode-fork 内部通过 `sandboxArgs = { ...args }` 浅拷贝分离执行和记录。

---

*文档版本：v4.0*
*日期：2026-05-10*
