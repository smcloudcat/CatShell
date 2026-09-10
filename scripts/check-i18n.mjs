#!/usr/bin/env node
/**
 * i18n 覆盖率校验。
 *
 * 本项目以中文原文作为 i18n 键，`en-US` 字典渐进补齐；缺条目时界面会静默回退成
 * 中文，评审时很难发现。本脚本扫描 `src/` 下所有 `t('…')` 调用，与
 * `src/i18n/index.ts` 中 `en` 字典的键求差，缺失即失败。
 *
 * 另外，`src/i18n/errors.ts` 的 `ERROR_MESSAGE_KEYS`（错误码 → 文案）不走 `t('…')`
 * 调用，而是由 UI 层用变量取键，静态扫描不到；这里单独把该表的值并入检查范围。
 *
 * 已知不覆盖的情形：动态键（`t(variable)`）与模板串键（`` t(`${x}`) ``）。
 * 这两种写法本就不该出现——键必须是可静态提取的字面量，脚本会单独提示。
 *
 * 用法：node scripts/check-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const I18N_FILE = join(SRC, 'i18n', 'index.ts')
const ERRORS_FILE = join(SRC, 'i18n', 'errors.ts')

/** 代码仓库中忽略的目录。 */
const SKIP_DIRS = new Set(['node_modules', '__tests__'])

/** 匹配 `t('字面量')` / `t("字面量")`，单参数。 */
const CALL_RE = /\bt\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*\)/g
/** 匹配不应该出现的动态键：t(`…`) 或 t(变量)。 */
const DYNAMIC_RE = /\bt\(\s*(`|[A-Za-z_$])/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out)
    } else if (['.ts', '.tsx'].includes(extname(name))) {
      out.push(full)
    }
  }
  return out
}

/** 还原字符串字面量中的转义，仅处理会影响键匹配的两种。 */
function unescapeKey(raw) {
  return raw.replace(/\\(['"\\])/g, '$1')
}

/** 从 en 字典块中提取键集合。 */
function readEnKeys() {
  const source = readFileSync(I18N_FILE, 'utf8')
  const start = source.indexOf('const en')
  if (start === -1) throw new Error('未在 src/i18n/index.ts 中找到 en 字典')
  const end = source.indexOf('\n}', start)
  const block = source.slice(start, end === -1 ? undefined : end)

  const keys = new Set()
  const keyRe = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/gm
  for (const m of block.matchAll(keyRe)) {
    keys.add(unescapeKey(m[1] ?? m[2]))
  }
  return keys
}

/** 从错误码文案表中提取键：`ERROR_MESSAGE_KEYS` 的值就是 i18n 键。 */
function readErrorKeys() {
  const source = readFileSync(ERRORS_FILE, 'utf8')
  const start = source.indexOf('ERROR_MESSAGE_KEYS')
  if (start === -1) throw new Error('未在 src/i18n/errors.ts 中找到 ERROR_MESSAGE_KEYS')
  const end = source.indexOf('\n}', start)
  const block = source.slice(start, end === -1 ? undefined : end)

  const keys = new Set()
  const valueRe = /^\s*[A-Z0-9_]+:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*,?\s*$/gm
  for (const m of block.matchAll(valueRe)) {
    keys.add(unescapeKey(m[1] ?? m[2]))
  }
  return keys
}

const used = new Map()
const dynamic = []

for (const file of walk(SRC)) {
  // i18n 目录下的两个文件是「字典本体」与「错误码文案表」，不参与调用扫描。
  if (file === I18N_FILE || file === ERRORS_FILE) continue
  const source = readFileSync(file, 'utf8')
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')

  for (const m of source.matchAll(CALL_RE)) {
    const key = unescapeKey(m[1] ?? m[2])
    if (!used.has(key)) used.set(key, rel)
  }

  source.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const _ of line.matchAll(DYNAMIC_RE)) dynamic.push(`${rel}:${i + 1}`)
  })
}

// 错误码文案由 UI 层用变量取键（t(ERROR_MESSAGE_KEYS[code])），静态扫描不到，单独并入。
for (const key of readErrorKeys()) {
  if (!used.has(key)) used.set(key, 'src/i18n/errors.ts')
}

const enKeys = readEnKeys()
const missing = [...used.entries()].filter(([key]) => !enKeys.has(key)).sort((a, b) => a[0].localeCompare(b[0]))

console.log(`i18n 覆盖率：代码用到 ${used.size} 个键，en 字典 ${enKeys.size} 个条目`)

if (dynamic.length > 0) {
  console.log(`\n⚠ 发现 ${dynamic.length} 处动态键（应改为字面量，否则无法静态校验）：`)
  for (const loc of dynamic) console.log(`  ${loc}`)
}

if (missing.length > 0) {
  console.log(`\n✗ 有 ${missing.length} 个键缺少 en 条目（键以 JSON 形式列出，便于识别首尾空格）：`)
  for (const [key, where] of missing) console.log(`  ${JSON.stringify(key)}  ← ${where}`)
  console.log('\n请在 src/i18n/index.ts 的 en 字典中补齐上述条目。')
  process.exit(1)
}

// 反向检查：en 里有、字面量 t() 没用到的键。
// 注意这条**不能当失败**：status.* 之类的键是经 t(`status.${x}`) 动态引用的，
// ACTION_LABELS 等常量表的值同理，静态扫描看不到，属正常情况。
const unused = [...enKeys].filter((key) => !used.has(key))
if (unused.length > 0) {
  console.log(
    `\n提示：en 字典有 ${unused.length} 个条目未被字面量 t() 直接引用。` +
      '其中多为动态键引用（status.* 等），如需清理历史残留请人工核对。'
  )
}

console.log('\n✓ i18n 覆盖率校验通过')
