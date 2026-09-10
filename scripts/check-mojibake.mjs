#!/usr/bin/env node
/**
 * 源码乱码（mojibake）校验。
 *
 * 历史教训：曾有一次提交用按 GBK 解读的工具重写 `src/styles/*.css`，把 UTF-8 中文
 * 注释变成「閫氱敤瑙嗗浘」这类乱码，还夹带了 BOM 与丢失的换行。这类损坏不会让
 * 构建失败，肉眼又容易滑过去，因此在 CI 里单独拦一道。
 *
 * 判定原理：乱码字符正是「原 UTF-8 字节被按 GBK 解读」的产物，所以把乱码字符
 * 按 GBK 编码回去，就能还原出原始 UTF-8 字节流。若某行满足：
 *   含中文 · GBK 编码成功 · 字节流是合法 UTF-8 · 还原结果与原文不同 ·
 *   还原结果的非 ASCII 字符全部落在中文范围内
 * 即认定该行是乱码。
 *
 * Node 没有内置 GBK 编码器，这里用 `TextDecoder('gbk')` 枚举全部合法双字节组合
 * 反向建表，避免为此引入依赖。
 *
 * 另会检查私用区字符（U+E000–U+F8FF）——源码中不应出现，出现即说明转码丢过字节。
 *
 * 用法：node scripts/check-mojibake.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
// 只扫代码与样式：文档里会引用乱码样例来讲清楚这件事，纳入扫描只会误报。
const SCAN_EXTS = new Set(['.ts', '.tsx', '.css', '.html'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', '.workbuddy', 'coverage'])

// ---------- 反向构建 GBK 编码表（char -> [byte, byte]） ----------
const gbkDecoder = new TextDecoder('gbk')
const GBK_MAP = new Map()

const single = gbkDecoder.decode(new Uint8Array([0x80]))
if (single && single !== '\uFFFD') GBK_MAP.set(single, [0x80])

for (let hi = 0x81; hi <= 0xfe; hi += 1) {
  for (let lo = 0x40; lo <= 0xfe; lo += 1) {
    if (lo === 0x7f) continue
    const ch = gbkDecoder.decode(new Uint8Array([hi, lo]))
    if (ch.length === 1 && ch !== '\uFFFD' && !GBK_MAP.has(ch)) {
      GBK_MAP.set(ch, [hi, lo])
    }
  }
}

/** 把字符串按 GBK 编码成字节；遇到无法表示的字返回 null。 */
function encodeGbk(text) {
  const bytes = []
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const pair = GBK_MAP.get(ch)
    if (!pair) return null
    bytes.push(pair[0], pair[1])
  }
  return Uint8Array.from(bytes)
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

const CJK = /[\u4E00-\u9FFF]/
const PUA = /[\uE000-\uF8FF]/

function isCjkish(ch) {
  const c = ch.codePointAt(0)
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // 基本汉字
    (c >= 0x3000 && c <= 0x303f) || // 中文标点
    (c >= 0xff00 && c <= 0xffef) || // 全角
    (c >= 0x2000 && c <= 0x206f) || // 通用标点
    c === 0x00b7 // 间隔号
  )
}

/** 若该行是 GBK 乱码，返回还原后的文本，否则返回 null。 */
function restore(line) {
  if (!CJK.test(line)) return null
  const bytes = encodeGbk(line)
  if (!bytes) return null
  let fixed
  try {
    fixed = utf8Strict.decode(bytes)
  } catch {
    return null
  }
  if (fixed === line || !CJK.test(fixed)) return null
  const rest = [...fixed].filter((c) => c.codePointAt(0) > 127)
  return rest.every(isCjkish) ? fixed : null
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out)
    } else if (SCAN_EXTS.has(extname(name))) {
      out.push(full)
    }
  }
  return out
}

const mojibake = []
const privateUse = []

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    if (PUA.test(line)) privateUse.push(`${at}   ${line.trim().slice(0, 80)}`)
    const fixed = restore(line)
    if (fixed) mojibake.push({ at, line, fixed })
  })
}

if (mojibake.length > 0) {
  console.log(`✗ 发现 ${mojibake.length} 行乱码（疑似被按 GBK 误读）：\n`)
  for (const { at, line, fixed } of mojibake) {
    console.log(`  ${at}`)
    console.log(`    当前: ${line.trim()}`)
    console.log(`    应为: ${fixed.trim()}`)
  }
  console.log('\n请按「当前 → 应为」逐行还原，并确认编辑器以 UTF-8 保存。')
}

if (privateUse.length > 0) {
  console.log(`\n✗ 发现 ${privateUse.length} 行含私用区字符（U+E000–U+F8FF），转码时丢过字节：\n`)
  for (const loc of privateUse) console.log(`  ${loc}`)
}

if (mojibake.length > 0 || privateUse.length > 0) process.exit(1)

console.log(`✓ 未发现乱码（已扫描 ${walk(ROOT).length} 个文件）`)
