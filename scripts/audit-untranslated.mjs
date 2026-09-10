#!/usr/bin/env node
/**
 * 辅助审计：找出未被 `en` 字典覆盖的中文字符串字面量。
 *
 * 与 `check-i18n.mjs` 的分工：
 * - `check-i18n.mjs` 只校验 `t('字面量')` 形式的键，覆盖 CI 必须通过的部分；
 * - 本脚本进一步扫描**所有**中文字面量，因此能发现间接引用的缺口，例如
 *   `t(ACTION_LABELS[action])` 这类「值来自常量表」的键——它们同样是用户可见
 *   文案，但静态分析看不到 `t(` 的直接参数。
 *
 * 输出需要人工判断：以下类别属于正常情况，不是缺陷：
 * - `console.*` 里的中文：开发者日志，不面向用户；
 * - `recordAudit(..., '中文')` 的中文：审计记录的 target/detail 字段；
 * - `throw new Error('中文')`：错误对象消息，是否展示由调用方决定。
 * 脚本会把它们单独分组，便于快速过滤。
 *
 * 本脚本不接入 CI（存量噪声未清零），按需手动运行：
 *   node scripts/audit-untranslated.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const I18N_FILE = join(SRC, 'i18n', 'index.ts')
const SKIP_DIRS = new Set(['node_modules', '__tests__'])

/** 从 en 字典块中提取键集合。 */
function readEnKeys() {
  const source = readFileSync(I18N_FILE, 'utf8')
  const start = source.indexOf('const en')
  const block = source.slice(start, source.indexOf('\n}', start))
  const keys = new Set()
  for (const m of block.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/gm)) {
    keys.add((m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1'))
  }
  return keys
}

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

const ZH = /[\u4e00-\u9fff]/
const LITERAL = /(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g

const enKeys = readEnKeys()
const ui = new Map()
const other = new Map()

for (const file of walk(SRC)) {
  if (file === I18N_FILE) continue
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    const code = line.replace(/\/\/.*$/, '')
    const isDevOnly = /console\./.test(code) || /recordAudit\(/.test(code)
    for (const m of code.matchAll(LITERAL)) {
      const value = (m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1')
      if (!ZH.test(value) || enKeys.has(value)) continue
      const bucket = isDevOnly ? other : ui
      if (!bucket.has(value)) bucket.set(value, rel)
    }
  }
}

function report(title, entries, note) {
  console.log(`\n${title}：${entries.size} 条`)
  if (note) console.log(`  （${note}）`)
  for (const [key, where] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${JSON.stringify(key)}  <- ${where}`)
  }
}

console.log('未在 en 字典中的中文字面量审计')
report('可能面向用户的文案', ui, '若非有意保留中文，应改为 t() 并补 en 条目')
report('开发者日志与审计记录', other, '通常无需翻译，仅作备案')

if (ui.size > 0) {
  console.log('\n提示：面向用户的文案建议全部走 t()，并补齐 src/i18n/index.ts 的 en 条目。')
}
