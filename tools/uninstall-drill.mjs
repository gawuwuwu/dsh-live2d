// dsh-live2d 的无网络安装/卸载工具。
//
// 用法（DSH 必须完全退出）：
//   node tools/uninstall-drill.mjs --check
//   node tools/uninstall-drill.mjs --before
//   node tools/uninstall-drill.mjs --manual-remove --yes
//   node tools/uninstall-drill.mjs --after
//   node tools/uninstall-drill.mjs --manual-install --yes
//   node tools/uninstall-drill.mjs --verify-installed
//   node tools/uninstall-drill.mjs --verify-uninstalled
//
// link: 安装不需要 pnpm。本工具只修改当前 profile 中 dsh-live2d 自己的
// bundle、dependency、lock importer 和 node_modules junction；每次写盘前
// 都会在 profile/.uninstall-backups/ 下备份 package.json 与 lockfile。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const pluginDir = fs.realpathSync.native(path.resolve(import.meta.dirname, '..'))
const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
const pluginName = pluginPkg.name
if (pluginName !== 'dsh-live2d') throw new Error(`工具目录不属于 dsh-live2d（读到 ${pluginName}）`)

const args = process.argv.slice(2)
const knownModes = new Set([
  '--check', '--before', '--after', '--manual-remove', '--manual-install',
  '--restore', '--verify-installed', '--verify-uninstalled',
])
const mode = args.find((arg) => knownModes.has(arg)) ?? '--check'
const yes = args.includes('--yes')
const profileArg = args.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length)
const profileName = profileArg || process.env.DSH_PROFILE || 'desktop'
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profile = path.join(dshHome, 'profiles', profileName)
const pkgFile = path.join(profile, 'package.json')
const lockFile = path.join(profile, 'pnpm-lock.yaml')
const patchFile = path.join(profile, 'cordis.patch.yml')
const nodeModules = path.join(profile, 'node_modules')
const linkPath = path.join(nodeModules, pluginName)
const drillDir = path.join(import.meta.dirname, '.drill')
const snapshotFile = path.join(drillDir, 'before.json')
const linkSpec = `link:${pluginDir.replaceAll('\\', '/')}`

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function normalizePath(value) {
  let text = String(value ?? '').trim()
  if (text.startsWith('\\\\?\\')) text = text.slice(4)
  try { text = path.resolve(text) } catch { /* keep */ }
  return text.replace(/[\\/]+$/, '').toLowerCase()
}

const samePath = (a, b) => Boolean(a && b && normalizePath(a) === normalizePath(b))

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, value, 'utf8')
  fs.renameSync(tmp, file)
}

function backupProfile() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(profile, '.uninstall-backups', stamp)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of [pkgFile, lockFile, patchFile]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, path.basename(file)))
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    at: new Date().toISOString(), profile, pluginDir, action: mode,
  }, null, 2))
  console.log(`备份：${dir}`)
}

function lockHasEntry(text) {
  return /^      dsh-live2d:\s*$/m.test(text)
}

function removeYamlEntry(text, key = pluginName) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex((line) => line === `      ${key}:`)
  if (index < 0) return text
  let end = index + 1
  while (end < lines.length) {
    const line = lines[end]
    if (!line.trim()) { end += 1; continue }
    if (line.length - line.trimStart().length > 6) { end += 1; continue }
    break
  }
  lines.splice(index, end - index)
  return lines.join(eol)
}

function insertLockEntry(text) {
  const clean = removeYamlEntry(text)
  const eol = clean.includes('\r\n') ? '\r\n' : '\n'
  const lines = clean.split(/\r?\n/)
  const importer = lines.findIndex((line) => /^  \.:\s*$/.test(line))
  if (importer < 0) throw new Error('pnpm-lock.yaml 里找不到 importers."."')
  let dependencies = -1
  for (let i = importer + 1; i < lines.length; i += 1) {
    if (/^    dependencies:\s*$/.test(lines[i])) { dependencies = i; break }
    if (/^  \S/.test(lines[i])) break
  }
  if (dependencies < 0) throw new Error('root importer 缺少 dependencies')
  lines.splice(dependencies + 1, 0,
    `      ${pluginName}:`,
    `        specifier: ${linkSpec}`,
    `        version: ${linkSpec}`,
  )
  return lines.join(eol)
}

function linkTarget() {
  try {
    const stat = fs.lstatSync(linkPath)
    if (!stat.isSymbolicLink()) return { exists: true, isLink: false, target: null }
    let target = fs.readlinkSync(linkPath)
    if (!path.isAbsolute(target)) target = path.resolve(nodeModules, target)
    return { exists: true, isLink: true, target }
  } catch {
    return { exists: false, isLink: false, target: null }
  }
}

function state() {
  const pkg = readJson(pkgFile, {})
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const dep = pkg?.dependencies?.[pluginName] ?? null
  const lockText = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : ''
  const link = linkTarget()
  return {
    profile,
    packageExists: fs.existsSync(pkgFile),
    lockExists: fs.existsSync(lockFile),
    patchExists: fs.existsSync(patchFile),
    bundles,
    hasBundle: bundles.includes(pluginName),
    dep,
    hasDep: Boolean(dep),
    lockHasEntry: lockHasEntry(lockText),
    linkExists: link.exists,
    linkIsJunction: link.isLink,
    linkTarget: link.target,
    linkPointsHere: samePath(link.target, pluginDir),
  }
}

function processes() {
  if (process.platform !== 'win32') return []
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/).filter((line) => /electron\.exe|deepseek harness\.exe/i.test(line))
  } catch {
    return []
  }
}

function printState(tag, current) {
  console.log(`\n=== ${tag} ===`)
  console.log(`profile:          ${current.profile}`)
  console.log(`bundle:           ${current.hasBundle ? '有' : '无'}`)
  console.log(`dependency:       ${current.hasDep ? current.dep : '无'}`)
  console.log(`lock importer:    ${current.lockHasEntry ? '有' : '无'}`)
  console.log(`node_modules link:${current.linkExists ? ` ${current.linkIsJunction ? 'junction' : '实体目录'}` : ' 无'}`)
  if (current.linkExists) console.log(`link target:      ${current.linkTarget ?? '(无法读取)'}`)
  console.log(`cordis.patch.yml: ${current.patchExists ? '存在' : '无'}`)
  const running = processes()
  console.log(`DSH/Electron 进程: ${running.length ? `${running.length} 个` : '无'}`)
}

function assertProfile() {
  if (!fs.existsSync(pkgFile)) throw new Error(`profile package.json 不存在：${pkgFile}`)
}

function removeJunction() {
  const link = linkTarget()
  if (!link.exists) return
  if (!link.isLink) throw new Error(`${linkPath} 不是 junction，拒绝递归删除实体目录`)
  if (!samePath(link.target, pluginDir)) throw new Error(`${linkPath} 指向 ${link.target}，不是当前插件，拒绝删除`)
  fs.rmdirSync(linkPath)
}

function createJunction() {
  fs.mkdirSync(nodeModules, { recursive: true })
  const link = linkTarget()
  if (link.exists) {
    if (link.isLink && samePath(link.target, pluginDir)) return
    throw new Error(`${linkPath} 已存在且不是指向当前插件的 junction`)
  }
  fs.symlinkSync(pluginDir, linkPath, 'junction')
}

function verifyInstalled(current = state()) {
  const issues = []
  if (!current.hasBundle) issues.push('缺少 bundle')
  if (current.dep !== linkSpec) issues.push(`dependency 不是 ${linkSpec}`)
  if (!current.lockHasEntry) issues.push('lockfile 缺少 importer')
  if (!current.linkExists || !current.linkIsJunction || !current.linkPointsHere) issues.push('node_modules junction 缺失或指向错误')
  if (!current.patchExists) issues.push('cordis.patch.yml 缺失')
  if (issues.length) throw new Error(`安装状态异常：${issues.join('; ')}`)
}

function verifyUninstalled(current = state()) {
  const issues = []
  if (current.hasBundle) issues.push('bundle 仍存在')
  if (current.hasDep) issues.push('dependency 仍存在')
  if (current.lockHasEntry) issues.push('lock importer 仍存在')
  if (current.linkExists) issues.push('node_modules junction 仍存在')
  if (issues.length) throw new Error(`卸载状态异常：${issues.join('; ')}`)
}

function report(tag) {
  const current = state()
  printState(tag, current)
  return current
}

function removePlugin() {
  assertProfile()
  const current = report('当前状态')
  if (current.linkExists && !current.linkPointsHere) throw new Error('node_modules link 指向其他目录，已停止')
  backupProfile()
  const pkg = readJson(pkgFile)
  if (pkg.dsh?.profile?.bundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== pluginName)
  if (pkg.dependencies) delete pkg.dependencies[pluginName]
  writeAtomic(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  if (fs.existsSync(lockFile)) writeAtomic(lockFile, removeYamlEntry(fs.readFileSync(lockFile, 'utf8')))
  removeJunction()
  const after = report('卸载后')
  verifyUninstalled(after)
  console.log('\n✅ 已完整卸载；未调用 pnpm，未删除用户配置。')
}

function installPlugin() {
  assertProfile()
  backupProfile()
  const pkg = readJson(pkgFile)
  pkg.dependencies ??= {}
  pkg.dependencies[pluginName] = linkSpec
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []
  if (!pkg.dsh.profile.bundles.includes(pluginName)) pkg.dsh.profile.bundles.push(pluginName)
  writeAtomic(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  if (!fs.existsSync(lockFile)) fs.writeFileSync(lockFile, "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n")
  writeAtomic(lockFile, insertLockEntry(fs.readFileSync(lockFile, 'utf8')))
  createJunction()
  const after = report('安装后')
  verifyInstalled(after)
  console.log('\n✅ 已完整安装；未调用 pnpm，未修改其他插件依赖。')
}

function diff(before, after) {
  const issues = []
  if (after.hasBundle) issues.push('bundles 里还留着 dsh-live2d')
  if (after.hasDep) issues.push(`dependencies 里还留着 ${after.dep}`)
  if (after.lockHasEntry) issues.push('pnpm-lock.yaml 里还留着 dsh-live2d importer')
  if (after.linkExists) issues.push('node_modules 里还留着 dsh-live2d')
  const missing = before.bundles.filter((id) => id !== pluginName && !after.bundles.includes(id))
  if (missing.length) issues.push(`其他 bundles 被误删：${missing.join(', ')}`)
  return issues
}

try {
  if (mode === '--check') {
    report('当前状态')
  } else if (mode === '--before') {
    fs.mkdirSync(drillDir, { recursive: true })
    const current = report('卸载前快照')
    fs.writeFileSync(snapshotFile, JSON.stringify(current, null, 2))
    console.log(`快照：${snapshotFile}`)
  } else if (mode === '--after') {
    const before = readJson(snapshotFile)
    if (!before) throw new Error('没有 before 快照，先执行 --before')
    const after = report('卸载后体检')
    const issues = diff(before, after)
    if (issues.length) throw new Error(`发现残留：\n  - ${issues.join('\n  - ')}`)
    console.log('\n✅ 没有残留')
  } else if (mode === '--manual-remove') {
    if (!yes) {
      report('当前状态')
      console.log('\n将清理 bundle/dependency/lock/junction；加 --yes 才会写盘。')
      process.exit(0)
    }
    removePlugin()
  } else if (mode === '--manual-install' || mode === '--restore') {
    if (!yes && mode !== '--restore') {
      report('当前状态')
      console.log('\n将写入 link dependency、bundle、lock importer 和 junction；加 --yes 才会写盘。')
      process.exit(0)
    }
    installPlugin()
  } else if (mode === '--verify-installed') {
    verifyInstalled()
    console.log('✅ 安装状态完整')
  } else if (mode === '--verify-uninstalled') {
    verifyUninstalled()
    console.log('✅ 卸载状态干净')
  } else {
    throw new Error(`未知参数 ${mode}`)
  }
} catch (error) {
  console.error(`\n❌ ${error?.message ?? error}`)
  process.exit(1)
}
