'use strict'

const { spawn } = require('node:child_process')

class CancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'CancelledError'
    this.cancelled = true
  }
}

class ProcessError extends Error {
  constructor(code, output) {
    const tail = String(output || '')
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line && !isNoise(line))
      .slice(-4)
      .join(' / ')
    super(tail || `进程退出，代码 ${code}`)
    this.name = 'ProcessError'
    this.exitCode = code
    this.output = output
  }
}

/**
 * 过滤掉 ncnn-vulkan 在部分显卡/远程桌面环境下的无意义告警。
 * 这些信息会淹没真正的错误，用户看到只会以为程序坏了。
 */
const NOISE_PATTERNS = [
  /vkQueueSubmit failed/i,
  /^vk[A-Z]\w+ failed/i,
  /^$/
]

function isNoise(line) {
  return NOISE_PATTERNS.some((pattern) => pattern.test(line))
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      /* 进程可能已经退出 */
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

/**
 * 执行外部命令，逐行回调输出。
 *
 * 进度类工具（esrgan / ffmpeg）用 \r 刷新同一行，这里把 \r 和 \n 都当作
 * 分隔符，保证上层能实时收到进度。
 */
function runProcess({ command, args, cwd, timeoutMs = 0, onLine, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError())
      return
    }

    let child
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }

    let output = ''
    let pending = ''
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }

    const onAbort = () => {
      killTree(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const consume = (chunk) => {
      output += chunk
      // 防止超长日志吃内存，只保留尾部
      if (output.length > 400_000) output = output.slice(-200_000)
      if (!onLine) return

      pending += chunk
      const parts = pending.split(/[\r\n]+/)
      pending = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (line && !isNoise(line)) onLine(line)
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child)
        finish(reject, new Error(`处理超时（超过 ${Math.round(timeoutMs / 60000)} 分钟）`))
      }, timeoutMs)
    }

    child.on('error', (error) => finish(reject, error))

    child.on('close', (code) => {
      if (pending.trim() && onLine && !isNoise(pending.trim())) onLine(pending.trim())
      pending = ''
      if (signal?.aborted) {
        finish(reject, new CancelledError())
        return
      }
      if (code === 0) finish(resolve, { code, output })
      else finish(reject, new ProcessError(code, output))
    })
  })
}

module.exports = { runProcess, killTree, isNoise, CancelledError, ProcessError }
