'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const DEFAULTS = {
  mode: 'image',
  theme: 'system',
  uiScale: 1.12,
  engine: 'esrgan',
  model: 'realesr-animevideov3',
  scale: 2,
  noise: 0,
  imageFormat: 'png',
  quality: 'standard',
  videoTarget: 'longEdge',
  longEdge: 1080,
  outputMode: 'suffix',
  outputDir: '',
  tileSize: 0,
  windowBounds: null
}

let cache = null

function file() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function read() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

function write(patch) {
  const next = { ...read(), ...patch }
  cache = next
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 配置写入失败不应影响主流程 */
  }
  return next
}

module.exports = { read, write, DEFAULTS }
