# opencode-autopilot

OpenCode **自动巡航模式** — Tab 切换到 autopilot agent 即进入全自主 AI 编程沙箱。

```
白天：手动监管 AI 驾驶（build/plan agent）
夜间：Tab → autopilot → 去睡觉
醒来：Tab → build → 审查改动 → 手动合入
```

---

## 核心机制

基于 **btrfs subvolume snapshot** 的块级 COW 全系统隔离：

```
Tab → autopilot:
  chat.message(agent="autopilot") → create() → btrfs snapshot @rootfs → @ap-<id>
  → snapshot 是完整根文件系统的瞬时可写副本
  → 所有工具调用自动重定向到 snapshot
  → bash 命令在 chroot 环境中执行

Tab → build:
  chat.message(agent="build") → deactivate() → 停止拦截，snapshot 保留供审查

退出 opencode:
  exit/SIGTERM → discardAll() + umount → 自动清理当前 session
```

**零 FUSE、零 kernel overlay、零 mount namespace。**

---

## 安装

```bash
git clone <repo-url> /root/autopilot
cd /root/autopilot
npm install
npm run build
```

**前置条件**：
- Linux + btrfs 根文件系统
- root 权限（opencode 进程需以 root 运行）

---

## 配置

`~/.config/opencode/opencode.json`：

```json
{
  "plugin": ["/root/autopilot"],
  "agent": {
    "autopilot": {
      "mode": "primary",
      "permission": { "*": "allow", "question": "deny" }
    }
  }
}
```

**环境变量**（可选）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTOPILOT_TOP_MNT` | `/dev/shm/oc-btrfs` | snapshot 挂载点目录 |
| `AUTOPILOT_BTRFS_SUBVOLID` | `5` | btrfs 顶层子卷 ID（非标布局时修改） |
| `AUTOPILOT_DEBUG` | `0` | 设为 `1` 显示原始命令和 snapshot 路径 |
| `AUTOPILOT_BYPASS_PREFIXES` | `/root/.opencode/` | 逗号分隔的白名单路径前缀，这些路径不进入 snapshot |

---

## 使用

```
Tab 切换到 autopilot agent
  → 自动创建 btrfs snapshot（如果未创建）
  → AI 自主工作，所有写入 COW 隔离
  → 无需 /autopilot on 命令

Tab 切换到 build/plan agent
  → 停止 sandbox 拦截
  → snapshot 保留供审查

手动清理 snapshot（审查后）:
  cd /root/autopilot
  npm run cleanup              # 交互式选择
  npm run cleanup -- --all     # 清理所有（需二次确认）

> **注意**：进程崩溃或 SIGKILL 后，snapshot 可能残留。这些孤儿 snapshot 不会自动清理，需手动运行 `npm run cleanup`。
```

### 沙箱行为

| 操作 | 效果 |
|------|------|
| `write`/`edit`/`read` | 路径重定向到 snapshot |
| `apply_patch` | `*** Add/Update/Delete File` 与 diff 路径重定向到 snapshot |
| `lsp` | 文件路径重定向到 snapshot |
| `glob`/`grep` | snapshot 内完整文件系统视图 |
| `bash` | chroot snapshot 内执行，全系统写隔离 |
| `memory` 路径 | 白名单绕过（`/root/.opencode/`），直写宿主 |
| **fork session** | **从父 session snapshot 继承修改** |

---

## 调试

```bash
# 显示原始命令和 snapshot 路径
export AUTOPILOT_DEBUG=1
opencode

# 查看当前 autopilot snapshots
btrfs subvolume list / | grep '@ap-'
```

---

## 安全设计

| 保护 | 机制 |
|------|------|
| 误删 root 子卷 | `startsWith(TOP_MNT + "/@ap-")` 路径检查 |
| 路径注入 | ID 正则 `^[a-zA-Z0-9_-]+$` |
| 路径遍历逃逸 | `path.resolve` + `startsWith` 边界校验 |
| Symlink 逃逸 | 对目标及最近存在父目录做 `realpathSync` 二次验证 |
| 设备验证 | `findmnt` 二次确认 |
| root 检测 | `process.getuid()` 前置拒绝 |
| 子卷名检测 | 动态 `btrfs subvolume show /` |
| bash 命令注入 | base64 编码管道，无变量展开 |
| 内部命令注入 | btrfs/mount 管理命令使用 `execFileSync(command, args)` |
| Hard link 穿透 | ⚠️ 未防护（见下方限制） |
| Bind mount 穿透 | ⚠️ 未防护（见下方限制） |

> **已知限制**：
> - chroot + root 权限下，AI 理论上可通过 `mknod` 创建设备节点访问物理硬件。
> - **Hard link 穿透**：AI 可在 snapshot 内创建指向宿主文件系统的 hard link，写入时穿透 COW 隔离。
> - **Bind mount 穿透**：chroot + root 下可通过 `mount --bind` 将宿主目录挂载进 snapshot，绕过隔离。
> - **PID / network namespace 共享**：chroot 内的进程与宿主共享 PID 和 network namespace。AI 可能误杀宿主进程或占用宿主机端口。systemd 服务在 chroot 内通常无法通过 `systemctl` 启动（缺少 D-Bus），绕过 systemctl 直接启动则会直接影响宿主。
>
> 本插件假设 AI 是**可信但可能出错**的协作者，而非完全不可信的隔离目标。如需对抗性隔离，需叠加 mount/pid/network namespace + seccomp-bpf。

---

## 文件结构

```
autopilot/
├── .opencode/prompts/autopilot.txt  # autopilot agent 提示词
├── src/
│   ├── index.ts                     # 插件入口（fork 检测 + 状态管理）
│   ├── sandbox.ts                   # btrfs snapshot + 安全校验 + fork 继承
│   └── hooks.ts                     # tool.execute.before/after 拦截
├── scripts/
│   ├── deploy-test.mjs              # 真实 btrfs 场景测试
│   └── opencode-fork-smoke.mjs      # opencode-fork 集成烟测
├── dist/
├── README.md + PLAN.md
└── tests ✅ (69 tests)
```

---

## 验证

```bash
npm run verify      # typecheck + unit tests + build
npm run test:real   # 真实 btrfs snapshot/fork/COW 测试
npm run test:fork   # 通过 /opt/opencode-fork 执行真实 autopilot smoke test
npm audit           # 依赖漏洞检查，当前应为 0 vulnerabilities
```

---

## 技术栈

- TypeScript + `@opencode-ai/plugin`
- btrfs-progs（系统依赖）
- 需要 root（CAP_SYS_ADMIN）

*版本：v0.2.1*
