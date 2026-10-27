'use strict'

/**
 * 把 Plyr 的图标 sprite 内联进 index.html。
 *
 * Plyr 3.8 的图标默认从 `https://cdn.plyr.io/.../plyr.svg` 拉取，离线环境会
 * 直接空白（控件在、图标没有）。这里把 17 个 symbol 塞进页面自带的 sprite，
 * 配合 app.js 里的 `iconUrl: false` 彻底断掉网络依赖。
 *
 * 用法：node scripts/inject-plyr-icons.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

const SVG_PATH = 'src/renderer/vendor/plyr.svg'
const HTML_PATH = 'src/renderer/index.html'
const START = '<!-- plyr-icons:start -->'
const END = '<!-- plyr-icons:end -->'

const svg = readFileSync(SVG_PATH, 'utf8')
const symbols = svg.match(/<symbol[\s\S]*?<\/symbol>/g) || []
if (!symbols.length) {
  console.error('plyr.svg 里没有 symbol')
  process.exit(1)
}

const block = [
  START,
  '    <svg class="sprite" aria-hidden="true">',
  ...symbols.map((item) => `      ${item}`),
  '    </svg>',
  `    ${END}`
].join('\n')

let html = readFileSync(HTML_PATH, 'utf8')
const existing = new RegExp(`[ \\t]*${START}[\\s\\S]*?${END}`)

if (existing.test(html)) {
  html = html.replace(existing, `      ${block}`)
} else {
  // 首次注入：放在自家 sprite 之后，作为独立容器
  html = html.replace(/(\n\s*)(<div class="app">)/, `\n${block}\n$1$2`)
}

writeFileSync(HTML_PATH, html, 'utf8')
console.log(`已注入 ${symbols.length} 个 Plyr 图标`)
