'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { runProcess } = require('../procs')
const { getFFmpegPath } = require('../paths')

const X264_BALANCED = {
  name: 'libx264 平衡',
  args: ['-c:v', 'libx264', '-preset', 'medium', '-threads', '2', '-x264-params', 'threads=2:lookahead_threads=1:rc-lookahead=20']
}

const X264_LOW_MEM = {
  name: 'libx264 低内存',
  args: ['-c:v', 'libx264', '-preset', 'veryfast', '-threads', '1', '-x264-params', 'threads=1:lookahead_threads=1:rc-lookahead=10']
}

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2)
}

function requireFFmpeg() {
  const bin = getFFmpegPath()
  if (!bin) {
    throw new Error('未找到 ffmpeg，请确认 resources/ffmpeg/ffmpeg.exe 存在')
  }
  return bin
}

/**
 * 解析 `ffmpeg -i` 的 stderr，拿到时长 / 尺寸 / 帧率 / 音轨。
 * 只有 ffmpeg 没有 ffprobe，所以走这段文本解析。
 */
async function probeMedia(filePath) {
  const bin = requireFFmpeg()
  let text = ''
  try {
    await runProcess({
      command: bin,
      args: ['-hide_banner', '-i', filePath],
      timeoutMs: 20_000
    })
  } catch (error) {
    text = error?.output || error?.message || ''
  }

  const result = {
    width: 0,
    height: 0,
    fps: 0,
    duration: 0,
    hasAudio: false,
    hasAlpha: false,
    bitDepth: 8,
    isHDR: false,
    videoCodec: '',
    raw: text
  }

  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (durationMatch) {
    result.duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
  }

  const videoLine = text.split(/[\r\n]+/).find((line) => line.includes('Video:')) || ''
  const sizeMatch = videoLine.match(/(\d{2,5})x(\d{2,5})/)
  if (sizeMatch) {
    result.width = Number(sizeMatch[1])
    result.height = Number(sizeMatch[2])
  }

  const fpsMatch = videoLine.match(/(\d+(?:\.\d+)?)\s*fps/) || videoLine.match(/(\d+(?:\.\d+)?)\s*tbr/)
  if (fpsMatch) {
    const fps = Number(fpsMatch[1])
    if (Number.isFinite(fps) && fps > 0 && fps < 1000) result.fps = fps
  }

  const codecMatch = videoLine.match(/Video:\s*([a-zA-Z0-9_]+)/)
  if (codecMatch) result.videoCodec = codecMatch[1]

  // rgba / argb / yuva420p / ya8 / gbrap 等均表示带透明通道
  result.hasAlpha = /\b(rgba|argb|bgra|abgr|yuva\d*|ya\d+|gbrap\w*)\b/i.test(videoLine)

  // yuv420p10le / p12 / p16 这类格式说明源是高比特深
  const depthMatch = videoLine.match(/yuv[a-z0-9]*?p(\d{2})(?:le|be)/i)
  if (depthMatch) result.bitDepth = Number(depthMatch[1])

  // PQ / HLG 才是真 HDR；单纯 bt2020 色彩空间仍按 SDR 处理
  result.isHDR = /(smpte2084|arib-std-b67)/i.test(videoLine)

  result.hasAudio = /Audio:\s/.test(text)

  return result
}

let nvencCache = null

/**
 * 探测 NVENC 是否真的可用。ffmpeg 编译带 nvenc 不代表机器有可用显卡，
 * 所以用一个 1 秒的纯色测试真实跑一遍，结果缓存。
 */
async function detectNvenc() {
  if (nvencCache !== null) return nvencCache
  const bin = getFFmpegPath()
  if (!bin) return (nvencCache = false)

  const testFile = path.join(require('node:os').tmpdir(), `omni-nvenc-probe-${Date.now()}.mp4`)
  try {
    await runProcess({
      command: bin,
      args: [
        '-hide_banner',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:d=0.2',
        '-c:v',
        'h264_nvenc',
        '-f',
        'mp4',
        '-y',
        testFile
      ],
      timeoutMs: 15_000
    })
    nvencCache = true
  } catch {
    nvencCache = false
  } finally {
    try {
      fs.rmSync(testFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  return nvencCache
}

function parseProgressLines(onProgress) {
  let frame = 0
  return (line) => {
    const frameMatch = line.match(/^frame=(\d+)/)
    if (frameMatch) frame = Number(frameMatch[1])
    const timeMatch = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/)
    if (timeMatch) {
      const raw = Number(timeMatch[1])
      // out_time_us 是微秒；部分构建里 out_time_ms 实际也是微秒
      const seconds = raw > 1e7 ? raw / 1_000_000 : raw / 1000
      onProgress?.({ frame, seconds })
      return
    }
    if (/^progress=end/.test(line)) {
      onProgress?.({ frame, done: true })
    }
  }
}

/**
 * 抽帧到 PNG 序列（无损，避免 AI 超分放大压缩伪影）。
 *
 * start + frameLimit 用于分段处理：按帧数精确切段，避免 -t 的秒级舍入导致
 * 段与段之间丢帧或多帧，累积起来会造成音画不同步。
 */
async function extractFrames({ input, outDir, fps, duration, start = 0, frameLimit = 0, onProgress, signal }) {
  const bin = requireFFmpeg()
  fs.mkdirSync(outDir, { recursive: true })
  const totalFrames =
    frameLimit > 0 ? frameLimit : Math.max(1, Math.round((duration || 0) * (fps || 24)))

  const handle = parseProgressLines(({ frame, seconds }) => {
    const done = frame > 0 ? frame : seconds * (fps || 24)
    onProgress?.(Math.min(1, done / totalFrames))
  })

  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1']
  if (start > 0.001) args.push('-ss', start.toFixed(3))
  args.push('-i', input)
  if (frameLimit > 0) args.push('-frames:v', String(frameLimit))
  args.push('-qscale:v', '1', '-qmin', '1', '-qmax', '1', '-vsync', '0', '-y')
  args.push(path.join(outDir, 'frame%08d.png'))

  await runProcess({
    command: bin,
    args,
    timeoutMs: 30 * 60 * 1000,
    onLine: handle,
    signal
  })

  const frames = fs.readdirSync(outDir).filter((name) => name.endsWith('.png'))
  if (frames.length === 0) throw new Error('未能从视频中提取到任何帧')
  return { frameCount: frames.length, pattern: path.join(outDir, 'frame%08d.png') }
}

async function encodeWithProfile({ bin, profile, crf, fps, pattern, source, output, frameCount, onProgress, signal }) {
  const handle = parseProgressLines(({ frame }) => {
    onProgress?.(Math.min(1, frame / Math.max(1, frameCount)))
  })

  await runProcess({
    command: bin,
    args: [
      '-hide_banner',
      '-nostats',
      '-progress',
      'pipe:1',
      '-framerate',
      String(fps || 24),
      '-i',
      pattern,
      ...(source ? ['-i', source] : []),
      '-map',
      '0:v:0',
      ...(source ? ['-map', '1:a?'] : []),
      ...profile.args,
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-y',
      output
    ],
    timeoutMs: 60 * 60 * 1000,
    onLine: handle,
    signal
  })
}

function isMemoryError(error) {
  const message = `${error?.message || ''} ${error?.output || ''}`
  return /(?:malloc|cannot allocate memory|out of memory|error initializing output stream|error while opening encoder|memory allocation)/i.test(
    message
  )
}

/**
 * 把超分后的帧序列重新编码成 MP4。
 * 依次尝试 NVENC（若可用）→ libx264 平衡 → libx264 低内存，
 * 后两步都基于已经超分好的帧，不需要重跑 AI。
 */
async function encodeVideo({ pattern, source, output, fps, frameCount, crf, onProgress, signal, log }) {
  const bin = requireFFmpeg()
  const profiles = []

  if (await detectNvenc()) {
    profiles.push({ name: 'NVENC 硬件编码', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf)] })
  }
  profiles.push(X264_BALANCED, X264_LOW_MEM)

  let lastError = null
  for (const profile of profiles) {
    try {
      log?.(`编码：${profile.name}`)
      await encodeWithProfile({ bin, profile, crf, fps, pattern, source, output, frameCount, onProgress, signal })
      const stat = fs.statSync(output, { throwIfNoEntry: false })
      if (!stat || stat.size === 0) throw new Error('编码输出为空')
      return profile.name
    } catch (error) {
      if (error?.cancelled) throw error
      lastError = error
      try {
        fs.rmSync(output, { force: true })
      } catch {
        /* ignore */
      }
      const retryable = isMemoryError(error) || /nvenc/i.test(profile.name)
      if (!retryable) break
      log?.(`${profile.name} 失败，改用下一档编码器`)
    }
  }

  if (isMemoryError(lastError)) {
    throw new Error('视频帧已超分完成，但重编码时内存不足。请关闭占用内存的程序后重试。')
  }
  throw lastError || new Error('视频编码失败')
}

/** 纯 FFmpeg 快速缩放（不走 AI，秒级完成） */
async function fastScale({ input, output, width, height, duration, crf, onProgress, signal, log }) {
  const bin = requireFFmpeg()

  const handle = parseProgressLines(({ seconds }) => {
    if (duration > 0) onProgress?.(Math.min(1, seconds / duration))
  })

  const runWithProfile = async (profile) =>
    runProcess({
      command: bin,
      args: [
        '-hide_banner',
        '-nostats',
        '-progress',
        'pipe:1',
        '-i',
        input,
        '-vf',
        `scale=${even(width)}:${even(height)}:flags=lanczos,setsar=1`,
        ...profile.args,
        '-crf',
        String(crf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-y',
        output
      ],
      timeoutMs: 60 * 60 * 1000,
      onLine: handle,
      signal
    })

  const profiles = []
  if (await detectNvenc()) {
    profiles.push({ name: 'NVENC 硬件编码', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf)] })
  }
  profiles.push(X264_BALANCED, X264_LOW_MEM)

  let lastError = null
  for (const profile of profiles) {
    try {
      log?.(`编码：${profile.name}`)
      await runWithProfile(profile)
      const stat = fs.statSync(output, { throwIfNoEntry: false })
      if (!stat || stat.size === 0) throw new Error('输出文件为空')
      return profile.name
    } catch (error) {
      if (error?.cancelled) throw error
      lastError = error
      try {
        fs.rmSync(output, { force: true })
      } catch {
        /* ignore */
      }
      if (!(isMemoryError(error) || /nvenc/i.test(profile.name))) break
      log?.(`${profile.name} 失败，改用下一档编码器`)
    }
  }
  throw lastError || new Error('视频缩放失败')
}

/** 纯 FFmpeg 图片重采样（无 GPU 时的兜底，不依赖 Vulkan） */
async function resizeImage({ input, output, width, height, onProgress, signal, log }) {
  const bin = requireFFmpeg()

  // lanczos 放大后补一点锐化，避免纯插值的绵软感
  const filter = `scale=${even(width)}:${even(height)}:flags=lanczos,setsar=1,unsharp=5:5:0.7:3:3:0.3`

  log?.(`FFmpeg 重采样 ${even(width)}x${even(height)}（lanczos + unsharp）`)

  await runProcess({
    command: bin,
    args: ['-hide_banner', '-nostats', '-i', input, '-vf', filter, '-frames:v', '1', '-y', output],
    timeoutMs: 10 * 60 * 1000,
    onLine: (line) => {
      const match = line.match(/^frame=\s*(\d+)/)
      if (match && Number(match[1]) > 0) onProgress?.(1)
    },
    signal
  })

  const stat = fs.statSync(output, { throwIfNoEntry: false })
  if (!stat || stat.size === 0) throw new Error('重采样输出为空')
  return { size: stat.size }
}

/**
 * 拼接分段视频并混入原音轨。
 *
 * 各段由同一套编码参数生成，concat 时直接 -c copy（不重新编码），
 * 所以分段不会引入额外画质损失，只是把「一次性占满磁盘」变成「滚动占用一段」。
 */
async function concatSegments({ segments, output, audioSource, signal, log }) {
  const bin = requireFFmpeg()
  if (!segments.length) throw new Error('没有可拼接的分段')

  if (segments.length === 1 && !audioSource) {
    fs.copyFileSync(segments[0], output)
    const stat = fs.statSync(output)
    return { size: stat.size }
  }

  const dir = path.dirname(output)
  const stamp = Date.now()
  const listPath = path.join(dir, `concat-${stamp}.txt`)
  const mergedPath = path.join(dir, `merged-${stamp}.mp4`)

  // concat 列表里单引号要转义成 '''
  const escapePath = (target) => target.replace(/'/g, "'\\''")
  fs.writeFileSync(
    listPath,
    segments.map((segment) => `file '${escapePath(segment)}'`).join('\n'),
    'utf8'
  )

  try {
    await runProcess({
      command: bin,
      args: [
        '-hide_banner',
        '-nostats',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        mergedPath
      ],
      timeoutMs: 60 * 60 * 1000,
      signal
    })

    if (audioSource) {
      log?.('混入原音轨')
      await runProcess({
        command: bin,
        args: [
          '-hide_banner',
          '-nostats',
          '-i',
          mergedPath,
          '-i',
          audioSource,
          '-map',
          '0:v:0',
          '-map',
          '1:a?',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-shortest',
          '-y',
          output
        ],
        timeoutMs: 60 * 60 * 1000,
        signal
      })
    } else {
      fs.copyFileSync(mergedPath, output)
    }
  } finally {
    fs.rmSync(listPath, { force: true })
    fs.rmSync(mergedPath, { force: true })
  }

  const stat = fs.statSync(output, { throwIfNoEntry: false })
  if (!stat || stat.size === 0) throw new Error('拼接后的视频为空')
  return { size: stat.size }
}

// ─────────────────────────────────────────────────────────────
// Alpha 通道处理
//
// realesrgan-ncnn-vulkan 对带透明通道的 PNG 处理不可靠：有时直接丢掉 alpha
// （透明区变黑），有时输出整张 alpha 全 0 的废图。所以含透明的素材必须拆开：
// 把 RGB 合成到白底交给 AI 超分，alpha 用 lanczos 单独放大，最后合并回去。
// ─────────────────────────────────────────────────────────────

function assertFFmpeg() {
  return requireFFmpeg()
}

/** 取出 alpha 通道为灰度图 */
async function extractAlpha({ input, output, signal }) {
  await runProcess({
    command: assertFFmpeg(),
    args: ['-hide_banner', '-nostats', '-i', input, '-vf', 'alphaextract', '-frames:v', '1', '-y', output],
    timeoutMs: 120_000,
    signal
  })
  if (!fs.existsSync(output)) throw new Error('提取 alpha 通道失败')
  return output
}

/** 把带透明的图合成到纯色底上，得到不含 alpha 的 RGB 图 */
async function flattenImage({ input, output, width, height, color = 'white', signal }) {
  const size = `${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`
  await runProcess({
    command: assertFFmpeg(),
    args: [
      '-hide_banner',
      '-nostats',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${size}`,
      '-i',
      input,
      '-filter_complex',
      '[0:v][1:v]overlay=shortest=1,format=rgb24',
      '-frames:v',
      '1',
      '-y',
      output
    ],
    timeoutMs: 120_000,
    signal
  })
  if (!fs.existsSync(output)) throw new Error('合成为不透明底图失败')
  return output
}

/** 按目标尺寸缩放 alpha（lanczos，与 AI 的放大倍率对齐） */
async function scaleAlpha({ input, output, width, height, signal }) {
  await runProcess({
    command: assertFFmpeg(),
    args: [
      '-hide_banner',
      '-nostats',
      '-i',
      input,
      '-vf',
      `scale=${even(width)}:${even(height)}:flags=lanczos,setsar=1`,
      '-frames:v',
      '1',
      '-y',
      output
    ],
    timeoutMs: 120_000,
    signal
  })
  if (!fs.existsSync(output)) throw new Error('缩放 alpha 通道失败')
  return output
}

/** 把缩放后的 alpha 贴回超分结果 */
async function mergeAlpha({ rgbPath, alphaPath, output, signal }) {
  await runProcess({
    command: assertFFmpeg(),
    args: [
      '-hide_banner',
      '-nostats',
      '-i',
      rgbPath,
      '-i',
      alphaPath,
      '-filter_complex',
      '[0:v][1:v]alphamerge',
      '-frames:v',
      '1',
      '-y',
      output
    ],
    timeoutMs: 120_000,
    signal
  })
  const stat = fs.statSync(output, { throwIfNoEntry: false })
  if (!stat || stat.size === 0) throw new Error('合并 alpha 通道失败')
  return { size: stat.size }
}

module.exports = {
  probeMedia,
  extractFrames,
  encodeVideo,
  fastScale,
  resizeImage,
  detectNvenc,
  even,
  extractAlpha,
  flattenImage,
  scaleAlpha,
  mergeAlpha,
  concatSegments
}
