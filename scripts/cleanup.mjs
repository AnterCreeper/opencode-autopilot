#!/usr/bin/env node
/**
 * Autopilot Snapshot Cleanup — 交互式清理工具
 * 
 * 用法：
 *   node scripts/cleanup.mjs                    # 交互式列出并选择
 *   node scripts/cleanup.mjs --session <id>     # 直接清理指定 session
 *   node scripts/cleanup.mjs --all              # 清理所有（需二次确认）
 * 
 * 特点：
 *   - 不经过 AI，完全由人类手动操作
 *   - 多重确认机制
 *   - 精确按 session 删除，不触碰其他 snapshot
 */

import { execFileSync } from "child_process"
import * as readline from "readline"
import * as path from "path"

const TOP_MNT = safeMountPath(process.env.AUTOPILOT_TOP_MNT || "/dev/shm/oc-btrfs")

function safeMountPath(mountPath) {
  if (!path.isAbsolute(mountPath) || mountPath.includes("\0")) {
    throw new Error(`Invalid AUTOPILOT_TOP_MNT: ${mountPath}`)
  }
  return path.resolve(mountPath)
}

function parseSnapshotName(fullPath) {
  const name = fullPath.split("/").pop()
  if (!/^@ap-[a-zA-Z0-9_-]+$/.test(name || "")) return undefined
  return name
}

function getSnapshots() {
  try {
    const output = execFileSync("btrfs", ["subvolume", "list", "/"], { encoding: "utf-8", timeout: 30000 })
    return output
      .split("\n")
      .map(line => {
        const parts = line.trim().split(/\s+/)
        const fullPath = parts[parts.length - 1]
        const name = parseSnapshotName(fullPath)
        if (!name) return undefined
        const sessionId = name.replace("@ap-", "")
        return {
          name,
          sessionId,
          path: `${TOP_MNT}/${name}`,
          id: parts[0], // btrfs subvolume ID
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function askQuestion(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()))
  })
}

async function cleanupSession(snapshot, rl) {
  console.log(`\n即将删除 snapshot: ${snapshot.name}`)
  console.log(`  Session ID: ${snapshot.sessionId}`)
  console.log(`  路径: ${snapshot.path}`)
  console.log("")
  
  const confirm1 = await askQuestion(rl, "确认删除? [y/N] ")
  if (confirm1.toLowerCase() !== "y") {
    console.log("已取消。")
    return false
  }
  
  const confirm2 = await askQuestion(rl, "此操作不可撤销。再次输入 'delete' 确认: ")
  if (confirm2 !== "delete") {
    console.log("已取消。")
    return false
  }
  
  try {
    execFileSync("btrfs", ["subvolume", "delete", snapshot.path], { timeout: 30000 })
    console.log(`✓ 已删除: ${snapshot.name}`)
    return true
  } catch (err) {
    console.error(`✗ 删除失败: ${snapshot.name}`)
    console.error(`  ${err.message}`)
    return false
  }
}

async function cleanupAll(rl, snapshots) {
  console.log(`\n将删除所有 ${snapshots.length} 个 snapshot。`)
  
  const confirm = await askQuestion(rl, "确认? [y/N] ")
  if (confirm.toLowerCase() !== "y") {
    console.log("已取消。")
    return
  }
  
  const confirm2 = await askQuestion(rl, "此操作不可撤销。再次输入 'delete-all' 确认: ")
  if (confirm2 !== "delete-all") {
    console.log("已取消。")
    return
  }
  
  for (const snapshot of snapshots) {
    try {
      execFileSync("btrfs", ["subvolume", "delete", snapshot.path], { timeout: 30000 })
      console.log(`✓ 已删除: ${snapshot.name}`)
    } catch (err) {
      console.error(`✗ 删除失败: ${snapshot.name}`)
    }
  }
}

async function interactiveCleanup() {
  const snapshots = getSnapshots()
  
  if (snapshots.length === 0) {
    console.log("没有找到 autopilot snapshot。")
    return
  }
  
  console.log("=== Autopilot Snapshots ===\n")
  snapshots.forEach((s, i) => {
    console.log(`  [${i + 1}] ${s.sessionId}`)
  })
  console.log("")
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  
  try {
    const answer = await askQuestion(rl, "选择要删除的 snapshot [编号/'a' 全部/'q' 退出]: ")
    
    if (answer.toLowerCase() === "q") {
      console.log("已退出。")
      return
    }
    
    if (answer.toLowerCase() === "a") {
      await cleanupAll(rl, snapshots)
      return
    }
    
    const idx = parseInt(answer, 10) - 1
    if (idx < 0 || idx >= snapshots.length) {
      console.log("无效选择。")
      return
    }
    
    await cleanupSession(snapshots[idx], rl)
  } finally {
    rl.close()
  }
}

async function cleanupBySessionId(sessionId) {
  const snapshots = getSnapshots()
  const target = snapshots.find(s => s.sessionId === sessionId)
  
  if (!target) {
    console.error(`未找到 session '${sessionId}' 的 snapshot。`)
    process.exitCode = 1
    return
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  
  try {
    await cleanupSession(target, rl)
  } finally {
    rl.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Autopilot Snapshot Cleanup

用法:
  node scripts/cleanup.mjs                  交互式选择
  node scripts/cleanup.mjs --session <id>   清理指定 session
  node scripts/cleanup.mjs --all            清理所有（需二次确认）
  node scripts/cleanup.mjs --help           显示此帮助

环境变量:
  AUTOPILOT_TOP_MNT    snapshot 挂载点 (默认: /dev/shm/oc-btrfs)
`)
    return
  }
  
  if (args.includes("--session")) {
    const idx = args.indexOf("--session")
    const sessionId = args[idx + 1]
    if (!sessionId) {
      console.error("错误: --session 需要一个 session ID")
      process.exitCode = 1
      return
    }
    await cleanupBySessionId(sessionId)
  } else if (args.includes("--all")) {
    const snapshots = getSnapshots()
    
    if (snapshots.length === 0) {
      console.log("没有找到 autopilot snapshot。")
      return
    }
    
    console.log("=== Autopilot Snapshots ===\n")
    snapshots.forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.sessionId}`)
    })
    console.log("")
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    
    try {
      await cleanupAll(rl, snapshots)
    } finally {
      rl.close()
    }
  } else {
    await interactiveCleanup()
  }
}

main().catch(err => {
  console.error("错误:", err.message)
  process.exitCode = 1
})
