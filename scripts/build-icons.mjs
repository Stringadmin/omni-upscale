'use strict'

/**
 * 从 lucide-static 生成内联 SVG sprite。
 * 只取界面实际用到的图标，避免把 1500+ 图标全打进 HTML。
 *
 * 用法：node scripts/build-icons.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ICONS = [
  'scan',
  'image',
  'video',
  'folder-open',
  'square',
  'x',
  'check',
  'triangle-alert',
  'move-horizontal',
  'external-link',
  'sun',
  'moon',
  'sliders-horizontal',
  'loader-circle',
  'circle-check',
  'rotate-ccw',
  'trash-2',
  'maximize-2',
  'mouse-pointer-2',
  'info',
  'terminal'
]

const root = 'node_modules/lucide-static/icons'
const parts = []

for (const name of ICONS) {
  const raw = readFileSync(join(root, `${name}.svg`), 'utf8')
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const body = inner
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim()
  parts.push(`      <symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
}

const sprite = `    <svg class="sprite" aria-hidden="true">\n${parts.join('\n')}\n    </svg>`

const target = 'src/renderer/sprite.html'
writeFileSync(target, `${sprite}\n`, 'utf8')
console.log(`生成 ${ICONS.length} 个图标 -> ${target}`)
