'use strict'

/**
 * 把 build-icons.mjs 生成的 sprite 注入 index.html。
 * 保持单文件 HTML，避免 file:// 下引用外部 sprite 的兼容问题。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const sprite = readFileSync('src/renderer/sprite.html', 'utf8').trimEnd()
const htmlPath = 'src/renderer/index.html'
const html = readFileSync(htmlPath, 'utf8')

const pattern = /[ \t]*<svg class="sprite"[\s\S]*?<\/svg>/
if (!pattern.test(html)) {
  console.error('未找到 sprite 占位块')
  process.exit(1)
}

writeFileSync(htmlPath, html.replace(pattern, sprite), 'utf8')
console.log('sprite 已注入 index.html')
