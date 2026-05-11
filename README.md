# opencode-autopilot

> **Platform Requirement: Linux/WSL only** — This plugin requires Linux with btrfs filesystem, bubblewrap, and root privileges. It will not work on macOS, Windows(native), or Linux/WSL without btrfs.

OpenCode **自动巡航模式** — Tab 切换到 Pilot agent 即进入全自主 AI 编程沙箱。

```
白天：手动监管 AI 驾驶（Build/Plan agent）
夜间：Tab → Pilot → 去睡觉
醒来：Tab → Build → 审查改动 → 手动合入
```

---

## 核心机制

基于 **btrfs subvolume snapshot** 的块级 COW + **bwrap namespace** 隔离：

```
Tab → Pilot:
  chat.message(agent="pilot") → create() → btrfs snapshot @rootfs → @ap-<id>
  → spawn bwrap（常驻后台 bash，mount namespace 挂载 snapshot 为 /）
  → 切换后再次进入 Pilot：复用已有 snapshot 和 bwrap，不重建

Tab → Build:
  chat.message(agent="build") → deactivate() → 停止拦截，bwrap 继续跑

退出 opencode:
  exit/SIGTERM → sessions.clear() → bwrap 随进程退出
  → snapshot 保留，手动 npm run cleanup
```

---

## 安装

### 1. 编译 patched opencode

本插件依赖对 opencode 的三处内部修正，需从 [antercreeper/opencode](https://github.com/antercreeper/opencode) 编译：

```bash
git clone https://github.com/antercreeper/opencode /opt/opencode-fork
cd /opt/opencode-fork
bun install
cd packages/opencode
bun run build -- --single --skip-embed-web-ui
```

编译产物位于 `dist/opencode-linux-x64/bin/opencode`。

创建启动脚本 `/usr/local/bin/opencode-fork`：

```bash
cat > /usr/local/bin/opencode-fork << 'EOF'
#!/bin/sh
OPENCODE_CONFIG_CONTENT='{"plugin":["/root/autopilot"],"agent":{"pilot":{"mode":"primary","color":"#9D7CD8","permission":{"*":"allow","question":"deny"}}}}' exec /path/to/opencode "$@"
EOF
chmod +x /usr/local/bin/opencode-fork
```

### 2. 安装插件

```bash
git clone <repo-url> /root/autopilot
cd /root/autopilot
npm install
npm run build
```

**前置条件**：
- Linux + btrfs 根文件系统
- bwrap（bubblewrap）
- root 权限（opencode 进程需以 root 运行）

---

## 配置

`~/.config/opencode/opencode.json`：

```json
{
  "plugin": ["/root/autopilot"],
  "agent": {
    "pilot": {
      "mode": "primary",
      "color": "#9D7CD8",
      "permission": { "*": "allow", "question": "deny" }
    }
  }
}
```

**环境变量**（可选）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTOPILOT_SNAPSHOT_DIR` | `/dev/shm/oc-btrfs` | snapshot 存储目录 |
| `AUTOPILOT_DEBUG` | `0` | 设为 `1` 显示原始 snapshot 路径（调试用） |
| `AUTOPILOT_BYPASS_PREFIXES` | `/root/.opencode/` | 逗号分隔，bwrap --bind 直通宿主 |
| `AUTOPILOT_BWRAP_FLAGS` | `--unshare-pid` | 完整覆盖 bwrap flags；可通过不包含 `--unshare-pid` 来关闭 PID 隔离 |

---

## 使用

```
Tab 切换到 Pilot agent
  → 自动创建 btrfs snapshot（如果未创建）
  → 启动 bwrap 沙箱环境

Tab 切换到 Build/Plan agent
  → 停止 sandbox 拦截
  → bwrap 进程继续运行（不 kill）
  → snapshot 保留供审查

手动清理 snapshot（审查后）:
  cd /root/autopilot
  npm run cleanup              # 交互式选择
  npm run cleanup -- --all     # 清理所有（需二次确认）
  npm run cleanup -- --session <id>  # 清理指定 session
```

如果 bwrap/sandbox 启动或健康检查失败，Pilot 会拒绝继续执行工具，不会自动降级到宿主机执行。用户需要先处理失败原因，再决定重试、切换 agent 或清理 snapshot。失败时已经创建的 snapshot 可能保留，可通过 `npm run cleanup` 清理。

### 沙箱行为

| 操作 | 效果 |
|------|------|
| `write`/`edit`/`read` | 路径重定向到 snapshot |
| `glob`/`grep` | snapshot 内完整文件系统视图 |
| `bash` | bwrap 内执行，mount namespace 隔离 |
| `memory` 路径 | 白名单 `--bind` 直通宿主 |
| **fork session** | **从父 session snapshot 继承修改** |

---

## 调试

```bash
# 显示原始 snapshot 路径
export AUTOPILOT_DEBUG=1
opencode

# 查看所有 snapshot
btrfs subvolume list / | grep '@ap-'
```

---

## 安全设计

| 保护 | 机制 |
|------|------|
| 文件系统修改 | btrfs COW snapshot |
| PID 误杀 | bwrap `--unshare-pid`（默认） |
| 路径遍历逃逸 | `path.resolve` + `startsWith` 边界校验 |
| Symlink 逃逸 | `realpathSync` 二次验证 |
| 设备验证 | `findmnt` 二次确认 |
| 内部命令注入 | `execFileSync(command, args)` |

**bwrap flags** 可通过 `AUTOPILOT_BWRAP_FLAGS` 完整覆盖。默认值为 `--unshare-pid`；例如 `--unshare-pid --unshare-net` 会同时启用 PID 和网络隔离，`--unshare-net` 则只启用网络隔离。

> **安全边界**：本插件隔离文件系统修改和进程可见性，适用"可信 AI 协作者的隔离执行"。如需对抗性沙箱，需叠加 seccomp-bpf。

---

## 文件结构

```
autopilot/
├── .opencode/prompts/autopilot.txt  # Pilot agent 提示词
├── src/
│   ├── index.ts                     # 插件入口（fork 检测 + 状态管理）
│   ├── sandbox.ts                   # btrfs snapshot + bwrap 管理
│   └── hooks.ts                     # tool.execute.before/after 拦截
├── scripts/
│   ├── deploy-test.mjs              # 真实 btrfs 场景测试
│   ├── cleanup.mjs                  # 手动 snapshot 清理
│   └── opencode-fork-smoke.mjs      # 集成烟测
├── dist/
├── README.md + PLAN.md
└── tests ✅ (71 tests)
```

---

## 验证

```bash
npm run verify      # typecheck + unit tests + build
npm run test:real   # 真实 btrfs snapshot/fork/COW 测试
npm run test:fork   # 通过 /opt/opencode-fork 执行真实 smoke test
```

---

## 技术栈

- TypeScript + `@opencode-ai/plugin`
- btrfs-progs + bubblewrap（系统依赖）
- 需要 root（CAP_SYS_ADMIN）

*版本：v4.0*
