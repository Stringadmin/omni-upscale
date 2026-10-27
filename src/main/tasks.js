'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const esrgan = require('./engines/esrgan')
const cugan = require('./engines/cugan')
const ffmpeg = require('./engines/ffmpeg')
const { workDir, removeDir } = require('./paths')

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.ts', '.mpg', '.mpeg'])

const QUALITY_CRF = { high: 16, standard: 18, small: 23 }

function kindOf(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/** 生成不覆盖已有文件的输出路径 */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let i = 1; i < 9999; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`)
}

function resolveOutput(input, options, kind, media) {
  const ext = path.extname(input)
  const base = path.basename(input, ext)
  // 只有视频的 FFmpeg 快速模式按目标长边命名，图片仍然按倍数
  const useLongEdge =
    kind === 'video' && options.engine === 'ffmpeg' && options.videoTarget !== 'scale'
  const suffix = useLongEdge ? `${options.longEdge || 1080}p` : `${options.scale}x`
  // JPEG 不支持透明通道，含 alpha 的图一律输出 PNG
  const keepAlpha = kind === 'image' && media?.hasAlpha
  const outExt = kind === 'video' ? '.mp4' : keepAlpha ? '.png' : `.${options.imageFormat || 'png'}`
  const dir = options.outputMode === 'folder' && options.outputDir ? options.outputDir : path.dirname(input)
  fs.mkdirSync(dir, { recursive: true })
  return uniquePath(path.join(dir, `${base}_${suffix}${outExt}`))
}

/**
 * 每段帧数：按「单段峰值临时空间 ≈ 300MB」反推。
 *
 * 中间帧是 PNG，经验上约 0.35 字节/像素（按超分后的尺寸算）；
 * 抽帧与超分帧会同时存在，所以乘 2。
 */
function computeChunkSize(info, scale) {
  const outPixels = (info.width || 1920) * scale * (info.height || 1080) * scale
  const bytesPerFrame = Math.max(1, outPixels * 0.35)
  const targetBytes = 300 * 1024 * 1024
  const byBytes = Math.floor(targetBytes / (bytesPerFrame * 2))
  // 段太短会让编码器启动开销占比过高；太长则峰值失控
  return Math.max(12, Math.min(600, byBytes))
}

function computeFastDims(width, height, options) {
  if (options.videoTarget === 'longEdge') {
    const longEdge = options.longEdge || 1080
    const isLandscape = width >= height
    const ratio = width / height
    if (!Number.isFinite(ratio) || ratio <= 0) return { width: longEdge, height: longEdge }
    return isLandscape
      ? { width: longEdge, height: ffmpeg.even(longEdge / ratio) }
      : { width: ffmpeg.even(longEdge * ratio), height: longEdge }
  }
  return { width: ffmpeg.even(width * options.scale), height: ffmpeg.even(height * options.scale) }
}

let seq = 0

class TaskQueue {
  constructor({ onUpdate, onLog }) {
    this.onUpdate = onUpdate
    this.onLog = onLog
    this.tasks = []
    this.running = null
    this.controller = null
    this.pumping = false
    this.pendingBroadcast = null
  }

  list() {
    return this.tasks.map((task) => this.serialize(task))
  }

  serialize(task) {
    return {
      id: task.id,
      kind: task.kind,
      input: task.input,
      name: task.name,
      output: task.output,
      status: task.status,
      progress: Math.round(task.progress * 10) / 10,
      phase: task.phase,
      message: task.message,
      error: task.error,
      engine: task.engine,
      model: task.model,
      scale: task.scale,
      inputSize: task.inputSize,
      outputSize: task.outputSize,
      width: task.width,
      height: task.height,
      outWidth: task.outWidth,
      outHeight: task.outHeight,
      duration: task.duration,
      warning: task.warning || '',
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      elapsedMs: task.finishedAt ? task.finishedAt - (task.startedAt || task.createdAt) : 0
    }
  }

  broadcast(immediate = false) {
    if (immediate) {
      if (this.pendingBroadcast) {
        clearTimeout(this.pendingBroadcast)
        this.pendingBroadcast = null
      }
      this.onUpdate?.(this.list())
      return
    }
    if (this.pendingBroadcast) return
    this.pendingBroadcast = setTimeout(() => {
      this.pendingBroadcast = null
      this.onUpdate?.(this.list())
    }, 120)
  }

  log(task, line) {
    // 保留最近 400 条，供「任务详情」窗口查看，控制台只留一份实时流
    if (!task.logs) task.logs = []
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    task.logs.push(`[${stamp}] ${line}`)
    if (task.logs.length > 400) task.logs.shift()
    this.onLog?.({ id: task.id, line })
  }

  logsOf(id) {
    const task = this.tasks.find((item) => item.id === id)
    return task?.logs || []
  }

  add(paths, options) {
    const added = []
    for (const file of paths) {
      const kind = kindOf(file)
      if (!kind) continue
      if (options.mode && options.mode !== kind) continue
      if (this.tasks.some((task) => task.input === file && task.status === 'pending')) continue

      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (!stat || !stat.isFile()) continue

      const task = {
        id: `t${Date.now().toString(36)}${(seq += 1).toString(36)}`,
        kind,
        input: file,
        name: path.basename(file),
        output: null,
        status: 'pending',
        progress: 0,
        phase: '排队中',
        message: '',
        error: '',
        engine: options.engine,
        model: options.model,
        scale: options.scale,
        options: { ...options },
        inputSize: stat.size,
        outputSize: 0,
        width: 0,
        height: 0,
        outWidth: 0,
        outHeight: 0,
        duration: 0,
        createdAt: Date.now(),
        startedAt: 0,
        finishedAt: 0,
        abort: null
      }
      this.tasks.push(task)
      added.push(this.serialize(task))
    }
    if (added.length) this.broadcast(true)
    return added
  }

  setProgress(task, value, phase) {
    const clamped = Math.max(0, Math.min(1, value))
    // 进度只增不减，避免多阶段回绕让用户以为卡住
    if (clamped >= task.progress) task.progress = clamped
    if (phase) task.phase = phase
    this.broadcast()
  }

  cancel(id) {
    const task = this.tasks.find((item) => item.id === id)
    if (!task) return false
    if (task.status === 'running') {
      task.abort?.abort()
      return true
    }
    if (task.status === 'pending') {
      task.status = 'cancelled'
      task.phase = '已取消'
      task.finishedAt = Date.now()
      this.broadcast(true)
      return true
    }
    return false
  }

  cancelAll() {
    for (const task of this.tasks) {
      if (task.status === 'pending' || task.status === 'running') this.cancel(task.id)
    }
  }

  remove(id) {
    const index = this.tasks.findIndex((item) => item.id === id)
    if (index < 0) return false
    const task = this.tasks[index]
    if (task.status === 'running') return false
    this.tasks.splice(index, 1)
    this.broadcast(true)
    return true
  }

  clearFinished() {
    this.tasks = this.tasks.filter((task) => task.status === 'running' || task.status === 'pending')
    this.broadcast(true)
  }

  async start() {
    if (this.pumping) return false
    this.pumping = true
    try {
      while (true) {
        const next = this.tasks.find((task) => task.status === 'pending')
        if (!next) break
        await this.runTask(next)
      }
    } finally {
      this.pumping = false
    }
    return true
  }

  async runTask(task) {
    this.running = task
    this.controller = new AbortController()
    task.abort = this.controller
    task.status = 'running'
    task.startedAt = Date.now()
    task.phase = '准备中'
    task.error = ''
    this.broadcast(true)

    const options = task.options
    const signal = this.controller.signal

    try {
      // 图片先探测一次：带透明通道要强制 PNG 输出，runImage 直接复用这份结果
      if (task.kind === 'image') {
        task.media = await ffmpeg.probeMedia(task.input).catch(() => null)
        if (task.media?.hasAlpha && options.imageFormat !== 'png') {
          this.log(task, '该图含透明通道，输出格式已固定为 PNG')
        }
      }
      task.output = resolveOutput(task.input, options, task.kind, task.media)
      if (task.kind === 'image') {
        await this.runImage(task, options, signal)
      } else {
        await this.runVideo(task, options, signal)
      }
      task.status = 'done'
      task.progress = 1
      task.phase = '完成'
      task.finishedAt = Date.now()
      const stat = fs.statSync(task.output, { throwIfNoEntry: false })
      task.outputSize = stat?.size || 0
      this.broadcast(true)
    } catch (error) {
      if (error?.cancelled) {
        task.status = 'cancelled'
        task.phase = '已取消'
        try {
          if (task.output) fs.rmSync(task.output, { force: true })
        } catch {
          /* ignore */
        }
      } else {
        task.status = 'error'
        task.phase = '失败'
        task.error = error?.message || String(error)
        this.log(task, `错误：${task.error}`)
      }
      task.finishedAt = Date.now()
      this.broadcast(true)
    } finally {
      task.abort = null
      this.running = null
      this.controller = null
    }
  }

  async runImage(task, options, signal) {
    const started = Date.now()
    this.log(task, `输入 ${task.name} (${formatBytes(task.inputSize)})`)

    const info = task.media || (await ffmpeg.probeMedia(task.input).catch(() => null))

    // ── 无 GPU 兜底：纯 FFmpeg 重采样 ──
    if (options.engine === 'ffmpeg') {
      if (!info?.width || !info?.height) throw new Error('无法读取图片尺寸')

      const width = ffmpeg.even(info.width * options.scale)
      const height = ffmpeg.even(info.height * options.scale)
      task.width = info.width
      task.height = info.height
      task.outWidth = width
      task.outHeight = height

      this.setProgress(task, 0.05, '重采样中')
      const result = await ffmpeg.resizeImage({
        input: task.input,
        output: task.output,
        width,
        height,
        signal,
        log: (line) => this.log(task, line),
        onProgress: (value) => this.setProgress(task, 0.05 + value * 0.93)
      })

      task.outputSize = result.size || 0
      this.setProgress(task, 1, '完成')
      this.log(task, `完成 ${width}x${height}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
      return
    }

    const engine = options.engine === 'cugan' ? cugan : esrgan
    const model = options.engine === 'cugan' ? null : options.model
    const scale = model && !esrganStatusScaleAllowed(model, options.scale) ? 4 : options.scale

    // ── 含透明通道：ncnn 会破坏 alpha，拆开单独处理 ──
    if (info?.hasAlpha) {
      this.log(task, '检测到透明通道，将分离 alpha 后单独放大')
      await this.upscaleWithAlpha({ task, engine, model, scale, options, signal, info, started })
      return
    }

    this.setProgress(task, 0.02, '超分中')

    const result = await engine.upscaleImage({
      input: task.input,
      output: task.output,
      model,
      scale,
      noise: options.noise,
      format: options.imageFormat || 'png',
      tileSize: options.tileSize,
      signal,
      log: (line) => this.log(task, line),
      onProgress: (value) => this.setProgress(task, 0.02 + value * 0.96)
    })

    task.outputSize = result.size || 0
    this.setProgress(task, 1, '完成')
    this.log(task, `完成 ${formatBytes(task.outputSize)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

    // 超分后尺寸从输出文件读一次，用于界面展示
    const dims = await ffmpeg.probeMedia(task.output).catch(() => null)
    if (dims?.width) {
      task.outWidth = dims.width
      task.outHeight = dims.height
    }
  }

  /**
   * 带 alpha 的图片：RGB 合成白底后走 AI，alpha 用 lanczos 放大，最后合并。
   *
   * 直接把 RGBA 丢给 realesrgan-ncnn-vulkan 会得到两种坏结果：透明区变黑，
   * 或者整张 alpha 变成 0（图片全透明）。所以必须拆开。
   */
  async upscaleWithAlpha({ task, engine, model, scale, options, signal, info, started }) {
    task.width = info.width || 0
    task.height = info.height || 0
    const dir = workDir(task.id)
    const alphaPath = path.join(dir, 'alpha.png')
    const flatPath = path.join(dir, 'flat.png')
    const rgbUpPath = path.join(dir, 'rgb-up.png')
    const alphaScaledPath = path.join(dir, 'alpha-scaled.png')
    const mergedPath = path.join(dir, 'merged.png')

    try {
      this.setProgress(task, 0.02, '分离透明通道')
      await ffmpeg.extractAlpha({ input: task.input, output: alphaPath, signal })
      await ffmpeg.flattenImage({
        input: task.input,
        output: flatPath,
        width: info.width,
        height: info.height,
        color: 'white',
        signal
      })

      this.setProgress(task, 0.08, '超分中')
      await engine.upscaleImage({
        input: flatPath,
        output: rgbUpPath,
        model,
        scale,
        noise: options.noise,
        format: 'png',
        tileSize: options.tileSize,
        signal,
        log: (line) => this.log(task, line),
        onProgress: (value) => this.setProgress(task, 0.08 + value * 0.82)
      })

      const dims = await ffmpeg.probeMedia(rgbUpPath)
      if (!dims?.width) throw new Error('无法读取超分结果尺寸')

      this.setProgress(task, 0.92, '合并透明通道')
      await ffmpeg.scaleAlpha({
        input: alphaPath,
        output: alphaScaledPath,
        width: dims.width,
        height: dims.height,
        signal
      })

      const merged = await ffmpeg.mergeAlpha({
        rgbPath: rgbUpPath,
        alphaPath: alphaScaledPath,
        output: mergedPath,
        signal
      })

      await fsp.copyFile(mergedPath, task.output)
      task.outputSize = merged.size
      task.outWidth = dims.width
      task.outHeight = dims.height
      this.setProgress(task, 1, '完成')
      this.log(
        task,
        `完成 ${dims.width}x${dims.height}（已恢复透明通道），耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`
      )
    } finally {
      removeDir(dir)
    }
  }

  async runVideo(task, options, signal) {
    const info = await ffmpeg.probeMedia(task.input)
    task.width = info.width
    task.height = info.height
    task.duration = info.duration
    this.log(
      task,
      `探测：${info.width}x${info.height} · ${info.fps || '?'}fps · ${info.duration.toFixed(1)}s · ${formatBytes(task.inputSize)}`
    )

    // 逐帧 AI 只处理 8bit RGB，高比特深与 HDR 会在这一步降级，必须明确告知
    const warnings = []
    if (info.isHDR) warnings.push('HDR 素材按 SDR 处理，颜色可能偏差')
    else if (info.bitDepth > 8) warnings.push(`${info.bitDepth}bit 源会输出为 8bit`)
    if (warnings.length) {
      task.warning = warnings.join('；')
      this.log(task, `注意：${task.warning}`)
    }

    const crf = QUALITY_CRF[options.quality] || QUALITY_CRF.standard

    // ── 快速模式：纯 FFmpeg 缩放，不走 AI ──
    if (options.engine === 'ffmpeg') {
      const dims = computeFastDims(info.width || 1920, info.height || 1080, options)
      task.outWidth = dims.width
      task.outHeight = dims.height
      this.setProgress(task, 0.03, '重采样中')
      this.log(task, `目标尺寸 ${dims.width}x${dims.height}`)
      await ffmpeg.fastScale({
        input: task.input,
        output: task.output,
        width: dims.width,
        height: dims.height,
        duration: info.duration,
        crf,
        signal,
        log: (line) => this.log(task, line),
        onProgress: (value) => this.setProgress(task, 0.03 + value * 0.95)
      })
      this.setProgress(task, 1, '完成')
      return
    }

    // ── AI 模式：分段处理（抽帧 → 逐帧超分 → 编码片段 → 拼接） ──
    const engine = options.engine === 'cugan' ? cugan : esrgan
    const scale = options.scale
    const fps = info.fps || 24
    const totalFrames = Math.max(1, Math.round(info.duration * fps))
    const chunkFrames = computeChunkSize(info, scale)
    const chunkCount = Math.ceil(totalFrames / chunkFrames)
    const dir = workDir(task.id)
    const segments = []

    const peakMb = Math.round(
      (chunkFrames * (info.width || 1920) * scale * (info.height || 1080) * scale * 0.35 * 2) /
        1024 /
        1024
    )
    this.log(
      task,
      `共 ${totalFrames} 帧，分 ${chunkCount} 段处理（每段 ${chunkFrames} 帧，峰值临时空间约 ${peakMb} MB）`
    )

    try {
      for (let index = 0; index < chunkCount; index += 1) {
        const startFrame = index * chunkFrames
        const framesThis = Math.min(chunkFrames, totalFrames - startFrame)
        const startSec = startFrame / fps

        // 前 96% 分给各段，最后 4% 留给拼接与混音
        const base = (index / chunkCount) * 0.96
        const span = (1 / chunkCount) * 0.96

        const segDir = path.join(dir, `seg-${index}`)
        const framesDir = path.join(segDir, 'frames')
        const upscaledDir = path.join(segDir, 'up')
        const segOutput = path.join(dir, `seg-${index}.mp4`)
        const label = `${index + 1}/${chunkCount}`

        this.setProgress(task, base, `抽帧 ${label}`)
        const { frameCount } = await ffmpeg.extractFrames({
          input: task.input,
          outDir: framesDir,
          fps,
          start: startSec,
          frameLimit: framesThis,
          signal,
          onProgress: (value) =>
            this.setProgress(task, base + span * value * 0.12, `抽帧 ${label}`)
        })

        this.setProgress(task, base + span * 0.12, `AI 超分 ${label}`)
        await engine.upscaleFrames({
          inputDir: framesDir,
          outputDir: upscaledDir,
          model: options.engine === 'cugan' ? null : options.model,
          scale,
          noise: options.noise,
          tileSize: options.tileSize,
          signal,
          log: (line) => this.log(task, line),
          onProgress: (value) =>
            this.setProgress(task, base + span * (0.12 + value * 0.7), `AI 超分 ${label}`)
        })

        this.setProgress(task, base + span * 0.82, `编码 ${label}`)
        await ffmpeg.encodeVideo({
          pattern: path.join(upscaledDir, 'frame%08d.png'),
          source: null,
          output: segOutput,
          fps,
          frameCount,
          crf,
          signal,
          log: (line) => {
            if (line.startsWith('编码')) this.log(task, line)
          },
          onProgress: (value) =>
            this.setProgress(task, base + span * (0.82 + value * 0.18), `编码 ${label}`)
        })

        segments.push(segOutput)
        // 立刻释放本段临时帧，磁盘占用回落到接近 0 再进入下一段
        removeDir(segDir)
        this.log(task, `第 ${label} 段完成，临时帧已清理`)
      }

      this.setProgress(task, 0.97, '拼接')
      const merged = await ffmpeg.concatSegments({
        segments,
        output: task.output,
        audioSource: info.hasAudio ? task.input : null,
        signal,
        log: (line) => this.log(task, line)
      })

      task.outputSize = merged.size
      task.outWidth = ffmpeg.even((info.width || 0) * scale)
      task.outHeight = ffmpeg.even((info.height || 0) * scale)
      this.setProgress(task, 1, '完成')
      this.log(task, `完成 ${formatBytes(merged.size)}，共 ${chunkCount} 段`)
    } finally {
      removeDir(dir)
    }
  }

}

/**
 * x4plus 系列只支持 4x，用户在界面上被锁定；这里再兜一层，
 * 防止通过命令行或旧配置传入 2x 导致模型找不到。
 */
function esrganStatusScaleAllowed(modelId, scale) {
  const model = esrgan.listModels().find((item) => item.id === modelId)
  if (!model) return false
  return model.scales.includes(scale)
}

module.exports = { TaskQueue, kindOf, formatBytes, IMAGE_EXT, VIDEO_EXT }
