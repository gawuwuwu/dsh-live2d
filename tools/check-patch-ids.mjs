// 安装前自检：patch 结构与 entry id 冲突
//
// 用法（在插件包里）：
//   node tools/check-patch-ids.mjs --profile "<你的 DSH profile 路径>" --plugin .
//
// 做三件事（全部只读，不装任何东西）：
//   1. 用 yaml 解析本插件的 cordis.patch.yml，并按 dsh-app-boot 的 patch schema 做结构校验；
//   2. 收集现有 profile 里所有 bundle patch 与 cordis.patch.yml 用到的 entry id；
//   3. 报告重名。
//
// 重名的两种含义（别混）：
//   · 同一个文件里写了两条同 id 的 entry → 硬冲突（后一条在前一条上覆盖，容易丢配置），报错；
//   · bundle 层与 profile 层出现同 id → 正常用法（profile 层就是用来覆盖 bundle 层的），只提示。
//
// 为什么需要它：DSH 的 patch 是「按 id 定位的覆盖/插入」，id 撞了不会抛错，只会静默覆盖。

import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const profileDir = resolve(arg('profile', join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop')))
const pluginDir = resolve(arg('plugin', '.'))
const requireFromProfile = createRequire(join(profileDir, 'package.json'))
const YAML = requireFromProfile('yaml')

const problems = []
const notes = []

// logLevel:'silent' —— 现有 bundle patch 里用了 !!js 表达式标签，yaml 会警告，这里不关心它。
const YAML_OPTIONS = { logLevel: 'silent' }
function readYamlFile(file) {
  return YAML.parse(readFileSync(file, 'utf8'), YAML_OPTIONS)
}

/** 收集一个 patch 文件里出现的所有 entry id：Map<id, 出现次数>。 */
function collectIdsFrom(patches, source) {
  const ids = new Map()
  const walk = (entries, where) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        problems.push(`${where}: 发现非对象条目 ${JSON.stringify(entry)?.slice(0, 80)}`)
        continue
      }
      if (typeof entry.id === 'string' && entry.id) {
        ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1)
      } else if (entry.insert === undefined) {
        problems.push(`${where}: 非 insert 的 patch 缺少 id（DSH 会告警并跳过）`)
      }
      if (entry.insert !== undefined) walk(entry.insert, `${where} → insert`)
    }
  }
  walk(patches, source)
  for (const [id, count] of ids) {
    if (count > 1) problems.push(`${source} 内 entry id '${id}' 出现 ${count} 次（同层重复会互相覆盖）`)
  }
  return ids
}

// ---- 1. 本插件 patch 结构校验 --------------------------------------------
const pluginPatchFile = join(pluginDir, 'cordis.patch.yml')
let ourIds = new Map()
if (!existsSync(pluginPatchFile)) {
  problems.push(`找不到 ${pluginPatchFile}`)
} else {
  let patches
  try {
    patches = readYamlFile(pluginPatchFile)
  } catch (error) {
    problems.push(`cordis.patch.yml 不是合法 YAML：${String(error?.message || error)}`)
  }
  if (patches !== undefined) {
    if (!Array.isArray(patches)) {
      problems.push('cordis.patch.yml 顶层必须是 YAML 数组')
    } else {
      const insertCount = patches.reduce((sum, item) => sum + (Array.isArray(item?.insert) ? item.insert.length : 0), 0)
      notes.push(`本插件 patch：${patches.length} 条 patch、${insertCount} 条插入 entry`)
      for (const [index, patch] of patches.entries()) {
        if (!patch || typeof patch !== 'object') {
          problems.push(`patch[${index}] 不是对象`)
          continue
        }
        if (patch.insert !== undefined && !Array.isArray(patch.insert)) {
          problems.push(`patch[${index}].insert 必须是数组`)
        }
        for (const [entryIndex, entry] of (patch.insert || []).entries()) {
          const where = `patch[${index}].insert[${entryIndex}]`
          if (typeof entry?.id !== 'string' || !entry.id) problems.push(`${where}.id 必须是非空字符串`)
          if (typeof entry?.name !== 'string' || !entry.name) problems.push(`${where}.name 必须是非空字符串（模块名）`)
          if (entry?.config !== undefined && (typeof entry.config !== 'object' || Array.isArray(entry.config) || entry.config === null)) {
            problems.push(`${where}.config 必须是对象`)
          }
        }
      }
      ourIds = collectIdsFrom(patches, 'dsh-live2d/cordis.patch.yml')
      if (ourIds.size === 0) notes.push('本插件 patch 没有插入任何 entry（只做覆盖）')
    }
  }
}

// ---- 2. 收集 profile 现有各层的 id ---------------------------------------
const manifestFile = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles ?? []
notes.push(`profile：${bundles.length} 个 bundle`)

/** 层名 → Map<id, ...>，用于区分「同层重复」与「跨层覆盖」。 */
const layers = new Map()

for (const bundleName of bundles) {
  const bundleDir = join(profileDir, 'node_modules', bundleName)
  const bundleManifestFile = join(bundleDir, 'package.json')
  if (!existsSync(bundleManifestFile)) {
    // @deepseek-ai/* 这些 bundle 由安装自带，不在 profile 的 node_modules 里，属正常。
    notes.push(`bundle 不在 profile 里（可能是安装自带）：${bundleName}`)
    continue
  }
  let bundleManifest
  try {
    bundleManifest = JSON.parse(readFileSync(bundleManifestFile, 'utf8'))
  } catch (error) {
    problems.push(`bundle 的 package.json 读不了：${bundleName}（${String(error?.message || error)}）`)
    continue
  }
  const patchDecl = bundleManifest?.dsh?.bundle?.patch
  const patchFiles = patchDecl === undefined ? [] : Array.isArray(patchDecl) ? patchDecl : [patchDecl]
  if (patchFiles.length === 0) {
    problems.push(`bundle ${bundleName} 没有声明 dsh.bundle.patch，却被列进了 dsh.profile.bundles`)
    continue
  }
  for (const relativeFile of patchFiles) {
    const patchFile = join(bundleDir, relativeFile)
    if (!existsSync(patchFile)) {
      problems.push(`bundle ${bundleName} 声明的 patch 不存在：${relativeFile}`)
      continue
    }
    try {
      layers.set(`${bundleName}/${relativeFile}`, collectIdsFrom(readYamlFile(patchFile), `${bundleName}/${relativeFile}`))
    } catch (error) {
      problems.push(`bundle ${bundleName} 的 patch 解析失败：${String(error?.message || error)}`)
    }
  }
}

const profilePatchFile = join(profileDir, 'cordis.patch.yml')
if (existsSync(profilePatchFile)) {
  try {
    layers.set('profile/cordis.patch.yml', collectIdsFrom(readYamlFile(profilePatchFile), 'profile/cordis.patch.yml'))
  } catch (error) {
    problems.push(`profile 的 cordis.patch.yml 解析失败：${String(error?.message || error)}`)
  }
}

// ---- 3. 本插件是否和其它层撞名 -------------------------------------------
for (const id of ourIds.keys()) {
  const owners = [...layers.entries()].filter(([, ids]) => ids.has(id)).map(([layer]) => layer)
  if (owners.length > 0) {
    notes.push(`注意：entry id '${id}' 也出现在 ${owners.join(', ')} —— 后应用的层会覆盖它`)
  }
}
notes.push(`本插件 entry id：${[...ourIds.keys()].join(', ') || '(无)'}`)

// ---- 输出 ----------------------------------------------------------------
console.log(notes.map((line) => `· ${line}`).join('\n'))
console.log('')
if (problems.length === 0) {
  console.log('✅ patch 结构检查通过')
} else {
  for (const problem of problems) console.log(`❌ ${problem}`)
  console.log('')
  console.log(`❌ ${problems.length} 项需要处理`)
  process.exitCode = 1
}
