'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { runProcess } = require('../procs')
const { getCuganPath, getCuganModelsDir } = require('../paths')

/**
 * Real-CUGAN 是可选引擎：运行时（可执行文件 + models-se）不在仓库里，
 * 用户把文件丢进 resources/realcugan/ 后自动启用。
 *
 * 目录约定：
 *   resources/realcugan/realcugan-ncnn-vulkan.exe
 *   resources/realcugan/models-se/*.bin|*.param
 */
const NOISE_LEVELS = [
  { value: -1, label: '不降噪', hint: '原图本身干净，只放大' },
  { value: 0, label: '保守', hint: '轻微降噪，保留纹理' },
  { value: 1, label: '轻度', hint: '常见压缩噪点' },
  { value: 2, label: '中度', hint: '明显噪点 / 低码率源' },
  { value: 3, label: '强力', hint: '噪点很重，细节会变平滑' }
]

const PROGRESS = /^(\d+(?:\.\d+)?)%$/

function status() {
  const bin = getCuganPath()
  const modelsDir = getCuganModelsDir()
  return {
    id: 'cugan',
    name: 'Real-CUGAN',
    available: Boolean(bin) && Boolean(modelsDir),
    binaryFound: Boolean(bin),
    modelsDir,
    noiseLevels: NOISE_LEVELS,
    reason: !bin
      ? '未安装 Real-CUGAN 运行时（resources/realcugan/）'
      : !modelsDir
        ? '缺少 models-se 模型目录'
        : null
  }
}

function progressHandler(onProgress) {
  return (line) => {
    const match = line.match(PROGRESS)
    if (!match) return
    const value = Number(match[1])
    if (Number.isFinite(value)) onProgress?.(Math.min(1, value / 100))
  }
}

function baseArgs({ scale, noise, modelsDir, tileSize }) {
  const args = ['-s', String(scale), '-n', String(noise)]
  if (modelsDir) args.push('-m', modelsDir)
  if (tileSize && Number.isFinite(tileSize) && tileSize >= 32) args.push('-t', String(tileSize))
  return args
}

async function upscaleImage({ input, output, scale, noise, tileSize, format, onProgress, signal, log }) {
  const bin = getCuganPath()
  if (!bin) throw new Error('未找到 Real-CUGAN 运行时')

  const args = ['-i', input, '-o', output, ...baseArgs({ scale, noise, modelsDir: getCuganModelsDir(), tileSize })]
  if (format) args.push('-f', format)

  log?.(`Real-CUGAN ${scale}x noise=${noise}`)

  await runProcess({
    command: bin,
    args,
    timeoutMs: 30 * 60 * 1000,
    onLine: progressHandler(onProgress),
    signal
  })

  const stat = fs.statSync(output, { throwIfNoEntry: false })
  if (!stat || stat.size === 0) throw new Error('超分输出为空')
  return { size: stat.size }
}

async function upscaleFrames({ inputDir, outputDir, scale, noise, tileSize, onProgress, signal, log }) {
  const bin = getCuganPath()
  if (!bin) throw new Error('未找到 Real-CUGAN 运行时')

  fs.mkdirSync(outputDir, { recursive: true })

  const args = [
    '-i',
    inputDir,
    '-o',
    outputDir,
    ...baseArgs({ scale, noise, modelsDir: getCuganModelsDir(), tileSize }),
    '-f',
    'png'
  ]

  log?.(`Real-CUGAN 逐帧超分 ${scale}x noise=${noise}`)

  await runProcess({
    command: bin,
    args,
    timeoutMs: 12 * 60 * 60 * 1000,
    onLine: progressHandler(onProgress),
    signal
  })

  const produced = fs.readdirSync(outputDir).filter((name) => name.endsWith('.png'))
  if (produced.length === 0) throw new Error('Real-CUGAN 未生成任何输出帧')
  return { frameCount: produced.length }
}

module.exports = { status, upscaleImage, upscaleFrames, NOISE_LEVELS }
