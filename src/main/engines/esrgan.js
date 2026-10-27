'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProcess } = require('../procs')
const { getEsrganPath, getEsrganModelsDir, getFFmpegPath } = require('../paths')

/**
 * Real-ESRGAN 模型清单。
 *
 * files 用于判断模型是否真的落在磁盘上——只有可执行文件而缺模型时，
 * 界面应该直接显示不可用，而不是等用户点了才报错。
 */
const MODELS = [
  {
    id: 'realesr-animevideov3',
    label: 'AnimeVideo V3',
    tag: '动漫 · 视频',
    hint: '动漫与 3D 动画首选，速度最快',
    scales: [2, 3, 4],
    files: [
      'realesr-animevideov3-x2.bin',
      'realesr-animevideov3-x2.param',
      'realesr-animevideov3-x3.bin',
      'realesr-animevideov3-x3.param',
      'realesr-animevideov3-x4.bin',
      'realesr-animevideov3-x4.param'
    ]
  },
  {
    id: 'realesrgan-x4plus-anime',
    label: 'x4plus Anime',
    tag: '插画 · 线稿',
    hint: '静帧插画、漫画线稿，线条更硬更锐，仅 4x',
    scales: [4],
    files: ['realesrgan-x4plus-anime.bin', 'realesrgan-x4plus-anime.param']
  },
  {
    id: 'realesrgan-x4plus',
    label: 'x4plus General',
    tag: '写实 · 实拍',
    hint: '通用写实增强，实拍或半写实素材，仅 4x',
    scales: [4],
    files: ['realesrgan-x4plus.bin', 'realesrgan-x4plus.param']
  },
  {
    id: 'realesrnet-x4plus',
    label: 'RealESRNet x4plus',
    tag: '保守 · 少伪影',
    hint: '纹理保守，适合已较干净但有噪点的素材，仅 4x',
    scales: [4],
    files: ['realesrnet-x4plus.bin', 'realesrnet-x4plus.param']
  }
]

const EPSRGAN_PROGRESS = /^(\d+(?:\.\d+)?)%$/

function missingFiles(model) {
  const dir = getEsrganModelsDir()
  if (!dir) return model.files.slice()
  return model.files.filter((name) => !fs.existsSync(path.join(dir, name)))
}

function listModels() {
  return MODELS.map((model) => {
    const missing = missingFiles(model)
    return {
      id: model.id,
      label: model.label,
      tag: model.tag,
      hint: model.hint,
      scales: model.scales,
      available: missing.length === 0,
      missing
    }
  })
}

function status() {
  const bin = getEsrganPath()
  const modelsDir = getEsrganModelsDir()
  const models = listModels()
  return {
    id: 'esrgan',
    name: 'Real-ESRGAN',
    available: Boolean(bin) && models.some((model) => model.available),
    binaryFound: Boolean(bin),
    modelsDir,
    models,
    reason: !bin
      ? '未找到 realesrgan-ncnn-vulkan 可执行文件'
      : !modelsDir
        ? '未找到 models 模型目录'
        : models.every((model) => !model.available)
          ? '模型文件不完整'
          : null
  }
}

function buildBaseArgs({ model, scale, modelsDir, tileSize }) {
  const args = ['-n', model, '-s', String(scale)]
  if (modelsDir) args.push('-m', modelsDir)
  if (tileSize && Number.isFinite(tileSize) && tileSize >= 32) args.push('-t', String(tileSize))
  return args
}

function progressHandler(onProgress) {
  return (line) => {
    const match = line.match(EPSRGAN_PROGRESS)
    if (!match) return
    const value = Number(match[1])
    if (Number.isFinite(value)) onProgress?.(Math.min(1, value / 100))
  }
}

/** 单张图片超分 */
async function upscaleImage({ input, output, model, scale, format, tileSize, onProgress, signal, log }) {
  const bin = getEsrganPath()
  if (!bin) throw new Error('未找到 Real-ESRGAN 运行时')

  const args = ['-i', input, '-o', output, ...buildBaseArgs({ model, scale, modelsDir: getEsrganModelsDir(), tileSize })]
  if (format) args.push('-f', format)

  log?.(`Real-ESRGAN ${model} ${scale}x`)

  await runProcess({
    command: bin,
    args,
    timeoutMs: 30 * 60 * 1000,
    onLine: progressHandler(onProgress),
    signal
  })

  const stat = fs.statSync(output, { throwIfNoEntry: false })
  if (!stat || stat.size === 0) throw new Error('超分输出为空，可能显存不足或输入图片损坏')
  return { size: stat.size }
}

/** 整个帧目录超分（ncnn-vulkan 原生支持目录批处理） */
async function upscaleFrames({ inputDir, outputDir, model, scale, tileSize, onProgress, signal, log }) {
  const bin = getEsrganPath()
  if (!bin) throw new Error('未找到 Real-ESRGAN 运行时')

  fs.mkdirSync(outputDir, { recursive: true })

  const args = [
    '-i',
    inputDir,
    '-o',
    outputDir,
    ...buildBaseArgs({ model, scale, modelsDir: getEsrganModelsDir(), tileSize }),
    '-f',
    'png'
  ]

  log?.(`Real-ESRGAN 逐帧超分 ${model} ${scale}x`)

  await runProcess({
    command: bin,
    args,
    timeoutMs: 12 * 60 * 60 * 1000,
    onLine: progressHandler(onProgress),
    signal
  })

  const produced = fs.readdirSync(outputDir).filter((name) => name.endsWith('.png'))
  if (produced.length === 0) throw new Error('Real-ESRGAN 未生成任何输出帧')
  return { frameCount: produced.length }
}

module.exports = { status, listModels, upscaleImage, upscaleFrames, probeRuntime, resetProbe }

/**
 * 真实可用性探测。
 *
 * ncnn-vulkan 没有 CPU 回退：机器没有可用 Vulkan 设备（老核显、虚拟机、
 * 服务器、驱动异常）时它会直接失败。光看文件存不存在判断不出来，必须真跑一次。
 * 这里用 16x16 的纯色图做最小验证，正常显卡 1 秒内完成，超时即视为不可用。
 */
let probeCache = null

function resetProbe() {
  probeCache = null
}

async function probeRuntime({ timeoutMs = 25_000 } = {}) {
  if (probeCache) return probeCache

  const bin = getEsrganPath()
  const modelsDir = getEsrganModelsDir()
  if (!bin) {
    probeCache = { ok: false, reason: '未找到 realesrgan-ncnn-vulkan 可执行文件' }
    return probeCache
  }
  if (!modelsDir) {
    probeCache = { ok: false, reason: '未找到 models 模型目录' }
    return probeCache
  }

  const ffmpegPath = getFFmpegPath()
  if (!ffmpegPath) {
    probeCache = { ok: false, reason: '缺少 ffmpeg，无法完成自检' }
    return probeCache
  }

  const dir = path.join(os.tmpdir(), `omni-gpu-probe-${Date.now()}`)
  const input = path.join(dir, 'probe.png')
  const output = path.join(dir, 'probe-out.png')

  try {
    fs.mkdirSync(dir, { recursive: true })
    await runProcess({
      command: ffmpegPath,
      args: ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=0x204040:s=16x16:d=1', '-frames:v', '1', '-y', input],
      timeoutMs: 15_000
    })

    const startedAt = Date.now()
    await runProcess({
      command: bin,
      args: ['-i', input, '-o', output, '-n', 'realesr-animevideov3', '-s', '2', '-m', modelsDir],
      timeoutMs
    })
    const elapsed = Date.now() - startedAt

    const stat = fs.statSync(output, { throwIfNoEntry: false })
    if (!stat || stat.size === 0) {
      probeCache = {
        ok: false,
        reason: '自检没有产生输出，显卡驱动可能不支持 Vulkan',
        elapsed
      }
      return probeCache
    }

    // 16x16 的纯色图正常显卡 1 秒内完成；超过 8 秒说明是软件渲染或驱动有问题的独显，
    // 仍允许使用，但要提醒用户改用快速模式
    const slow = elapsed > 8000
    probeCache = {
      ok: true,
      elapsed,
      slow,
      reason: slow ? '显卡性能较弱，AI 超分会很慢' : null,
      checkedAt: Date.now()
    }
    return probeCache
  } catch (error) {
    const message = String(error?.message || error)
    let reason = message
    if (/timed out|超时/i.test(message)) {
      reason = '自检超时，显卡可能不支持 Vulkan 或驱动异常'
    } else if (/vulkan|vkCreate|vkEnumerate|vkQueue|driver/i.test(message)) {
      reason = '当前设备没有可用的 Vulkan 支持'
    }
    probeCache = { ok: false, reason }
    return probeCache
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
