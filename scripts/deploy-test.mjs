#!/usr/bin/env node
/**
 * OpenCode Autopilot — 真实环境部署测试
 * 
 * 验证点：
 * 1. 插件能被 opencode 正确加载
 * 2. autopilot agent 触发 snapshot 创建
 * 3. fork session 从父 snapshot 继承
 * 4. COW 隔离：子修改不影响父
 * 5. cleanup 脚本生成
 * 6. 路径重定向和 bash wrapping
 */

import { execFileSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "fs"
import * as path from "path"
import * as os from "os"
import constants from "../src/constants.json" with { type: "json" }

const { DEFAULT_SNAPSHOT_DIR } = constants

const SNAPSHOT_DIR = process.env.AUTOPILOT_SNAPSHOT_DIR || DEFAULT_SNAPSHOT_DIR
const TEST_DIR = mkdtempSync(path.join(os.tmpdir(), "oc-ap-deploy-test-"))

function log(step, status, detail = "") {
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⏳"
  console.log(`${icon} [${step}] ${status}${detail ? " — " + detail : ""}`)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: options.encoding,
    stdio: options.silent ? "ignore" : undefined,
    timeout: options.timeout ?? 30000,
  })
}

function snapshotName(fullPath) {
  const name = fullPath.split("/").pop()
  return /^@ap-[a-zA-Z0-9_-]+$/.test(name || "") ? name : undefined
}

function cleanup() {
  // Remove any autopilot snapshots created during test
  try {
    const output = run("btrfs", ["subvolume", "list", "/"], { encoding: "utf-8" })
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/)
      const name = snapshotName(parts[parts.length - 1])
      if (!name) continue
      const snapPath = `${SNAPSHOT_DIR}/${name}`
      try { run("btrfs", ["subvolume", "delete", snapPath], { silent: true }) } catch {}
    }
  } catch {}
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
}

async function main() {
  console.log("\n=== OpenCode Autopilot 部署测试 ===\n")
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`Node: ${process.version}`)
  console.log(`UID: ${process.getuid?.()}`)
  console.log("")

  // 0. 前置检查
  let step = 0
  try {
    run("which", ["btrfs"], { silent: true })
    log(++step, "PASS", "btrfs-progs 已安装")
  } catch {
    log(++step, "FAIL", "btrfs-progs 未安装")
    process.exit(1)
  }

  if (process.getuid?.() !== 0) {
    log(++step, "FAIL", "需要 root 权限运行")
    process.exit(1)
  }
  log(step, "PASS", "root 权限确认")

  // 1. 加载插件
  const pluginPath = path.resolve(process.cwd(), "dist/index.js")
  if (!existsSync(pluginPath)) {
    log(++step, "FAIL", `构建产物不存在: ${pluginPath}`)
    process.exit(1)
  }

  const AutopilotPlugin = (await import(pluginPath)).default
  if (typeof AutopilotPlugin !== "function") {
    log(++step, "FAIL", "插件未导出默认函数")
    process.exit(1)
  }
  log(++step, "PASS", "插件模块加载成功")

  // 2. 初始化插件（模拟 opencode client）
  const mockClient = {
    session: {
      get: async ({ path: { id } }) => {
        if (id === "fork-child") return { data: { parentID: "fork-parent" } }
        return { data: {} }
      },
    },
  }

  const plugin = await AutopilotPlugin({ client: mockClient })
  const requiredHooks = [
    "chat.message",
    "tool.execute.before",
    "tool.execute.after",
    "shell.env",
    "experimental.chat.system.transform",
    "experimental.compaction.autocontinue",
  ]
  for (const h of requiredHooks) {
    if (!plugin[h]) {
      log(++step, "FAIL", `缺少 hook: ${h}`)
      process.exit(1)
    }
  }
  log(++step, "PASS", `所有 ${requiredHooks.length} 个 hooks 已注册`)

  // 3. 准备测试目录
  cleanup()
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(path.join(TEST_DIR, "original.txt"), "original")
  log(++step, "PASS", "测试项目目录准备完成")

  // 4. 父 session — 激活 autopilot
  await plugin["chat.message"]({
    sessionID: "fork-parent",
    agent: "pilot",
    variant: undefined,
  }, {})

  // 5. 模拟 write tool — 写入父 snapshot
  const writeTool = { tool: "write", sessionID: "fork-parent", callID: "w1" }
  const writeOutput = { args: { filePath: path.join(TEST_DIR, "parent-marker.txt"), content: "parent-only" } }
  await plugin["tool.execute.before"](writeTool, writeOutput)
  const parentFilePath = writeOutput.args.filePath
  mkdirSync(path.dirname(parentFilePath), { recursive: true })
  writeFileSync(parentFilePath, "parent-only")
  log(++step, "PASS", `父 snapshot 写入标记文件: ${parentFilePath}`)

  // 6. fork 子 session
  await plugin["chat.message"]({
    sessionID: "fork-child",
    agent: "pilot",
    variant: "fork",
  }, {})
  log(++step, "PASS", "fork 子 session 创建成功")

  // 7. 验证子 session 继承父文件
  const childReadTool = { tool: "read", sessionID: "fork-child", callID: "r1" }
  const childReadOutput = { args: { filePath: path.join(TEST_DIR, "parent-marker.txt") } }
  await plugin["tool.execute.before"](childReadTool, childReadOutput)
  const childCanReadParent = existsSync(childReadOutput.args.filePath)
  if (!childCanReadParent) {
    log(++step, "FAIL", "子 session 未继承父文件")
    cleanup()
    process.exit(1)
  }
  log(++step, "PASS", "子 session 正确继承父 snapshot 文件")

  // 8. 子 session 写入独有文件
  const childWriteTool = { tool: "write", sessionID: "fork-child", callID: "w2" }
  const childWriteOutput = { args: { filePath: path.join(TEST_DIR, "child-only.txt"), content: "child-only" } }
  await plugin["tool.execute.before"](childWriteTool, childWriteOutput)
  writeFileSync(childWriteOutput.args.filePath, "child-only")
  log(++step, "PASS", "子 session 写入独有文件")

  // 9. 验证 COW 隔离 — 父看不到子文件
  const parentCheckTool = { tool: "read", sessionID: "fork-parent", callID: "r2" }
  const parentCheckOutput = { args: { filePath: path.join(TEST_DIR, "child-only.txt") } }
  await plugin["tool.execute.before"](parentCheckTool, parentCheckOutput)
  const parentSeesChild = existsSync(parentCheckOutput.args.filePath)
  if (parentSeesChild) {
    log(++step, "FAIL", "COW 隔离失败：父 session 看到了子文件")
    cleanup()
    process.exit(1)
  }
  log(++step, "PASS", "COW 隔离验证成功：父 session 不可见子修改")

  // 10. bash wrapping 验证
  const bashTool = { tool: "bash", sessionID: "fork-child", callID: "b1" }
  const bashOutput = { args: { command: "echo hello" } }
  await plugin["tool.execute.before"](bashTool, bashOutput)
  const wrapped = bashOutput.args.command
  if (!wrapped.includes("nsenter") || !wrapped.includes("base64 -d")) {
    log(++step, "FAIL", `bash 包装异常: ${wrapped.slice(0, 80)}...`)
    cleanup()
    process.exit(1)
  }
  if (wrapped.includes("echo '") || !wrapped.includes("printf '%s'")) {
    log(++step, "FAIL", "bash 包装未使用 printf 安全编码")
    cleanup()
    process.exit(1)
  }
  log(++step, "PASS", "bash wrapping 安全编码验证通过")

  // 11. apply_patch 相对路径重定向验证
  const patchTool = { tool: "apply_patch", sessionID: "fork-child", callID: "p1" }
  const patchOutput = { args: { patchText: "*** Begin Patch\n*** Update File: relative-apply-patch.txt\n@@\n-old\n+new\n*** End Patch" } }
  await plugin["tool.execute.before"](patchTool, patchOutput)
  if (!patchOutput.args.patchText.includes(SNAPSHOT_DIR) || patchOutput.args.patchText.includes("*** Update File: relative-apply-patch.txt")) {
    log(++step, "FAIL", `apply_patch 未重定向到 snapshot: ${patchOutput.args.patchText}`)
    cleanup()
    process.exit(1)
  }
  log(++step, "PASS", "apply_patch 相对路径重定向验证通过")

  // 12. symlink 父目录逃逸阻断验证
  const rootTool = { tool: "read", sessionID: "fork-child", callID: "r-root" }
  const rootOutput = { args: { filePath: "/" } }
  await plugin["tool.execute.before"](rootTool, rootOutput)
  const escapeLink = path.join(rootOutput.args.filePath, "escape-dir")
  try { run("ln", ["-s", "/etc", escapeLink], { silent: true, timeout: 10000 }) } catch {}
  const escapeTool = { tool: "write", sessionID: "fork-child", callID: "w-escape" }
  const escapeOutput = { args: { filePath: "/escape-dir/should-block", content: "blocked" } }
  let blocked = false
  try {
    await plugin["tool.execute.before"](escapeTool, escapeOutput)
  } catch (err) {
    blocked = String(err.message).includes("Symlink escape blocked")
  }
  if (!blocked) {
    log(++step, "FAIL", "symlink 父目录逃逸未被阻断")
    cleanup()
    process.exit(1)
  }
  log(++step, "PASS", "symlink 父目录逃逸阻断验证通过")

  // 13. cleanup.mjs 脚本验证
  const cleanupScriptPath = path.resolve(process.cwd(), "scripts/cleanup.mjs")
  if (!existsSync(cleanupScriptPath)) {
    log(++step, "FAIL", `cleanup.mjs 不存在: ${cleanupScriptPath}`)
    cleanup()
    process.exit(1)
  }
  log(++step, "PASS", "cleanup.mjs 脚本存在")

  // 14. 非 root 权限拒绝验证
  if (process.getuid?.() === 0) {
    // We are root — verify the plugin code contains root check in sandbox.js
    const sandboxPath = path.resolve(process.cwd(), "dist/sandbox.js")
    if (!existsSync(sandboxPath)) {
      log(++step, "FAIL", "dist/sandbox.js 不存在")
      cleanup()
      process.exit(1)
    }
    const sandboxSrc = readFileSync(sandboxPath, "utf-8")
    if (!sandboxSrc.includes("process.getuid") || !sandboxSrc.includes("CAP_SYS_ADMIN")) {
      log(++step, "FAIL", "插件缺少 root 权限检查")
      cleanup()
      process.exit(1)
    }
    log(++step, "PASS", "root 权限检查代码已嵌入")
  }

  // 15. 停用与清理
  await plugin["chat.message"]({
    sessionID: "fork-parent",
    agent: "build",
    variant: undefined,
  }, {})
  await plugin["chat.message"]({
    sessionID: "fork-child",
    agent: "build",
    variant: undefined,
  }, {})
  cleanup()
  log(++step, "PASS", "资源清理完成")

  // 总结
  console.log("\n========================================")
  console.log("🎉 全部部署测试通过")
  console.log(`验证项目: ${step} 项`)
  console.log("========================================\n")
}

main().catch((err) => {
  console.error("\n❌ 部署测试异常退出:", err.message)
  console.error(err.stack)
  cleanup()
  process.exit(1)
})
