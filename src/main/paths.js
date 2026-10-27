'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

let cachedRuntimeRoot = null

/**
 * 运行时资源根目录（其下包含 realesrgan/ 与 ffmpeg/）。
 *
 * 打包后：<install>/resources/realesrgan
 * 开发时：<project>/resources/realesrgan
 */
function runtimeRoot() {
  if (cachedRuntimeRoot) return cachedRuntimeRoot

  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'realesrgan') : null,
    path.join(app.getAppPath(), 'resources', 'realesrgan')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedRuntimeRoot = path.dirname(candidate)
      return cachedRuntimeRoot
    }
  }

  // 找不到时返回开发路径，让上层报出可读的错误
  cachedRuntimeRoot = path.join(app.getAppPath(), 'resources')
  return cachedRuntimeRoot
}

function binaryName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base
}

function resolveBinary(relativeDir, baseName) {
  const full = path.join(runtimeRoot(), relativeDir, binaryName(baseName))
  return fs.existsSync(full) ? full : null
}

function getEsrganPath() {
  return resolveBinary('realesrgan', 'realesrgan-ncnn-vulkan')
}

function getEsrganModelsDir() {
  const dir = path.join(runtimeRoot(), 'realesrgan', 'models')
  return fs.existsSync(dir) ? dir : null
}

function getCuganPath() {
  return resolveBinary('realcugan', 'realcugan-ncnn-vulkan')
}

function getCuganModelsDir() {
  const base = path.join(runtimeRoot(), 'realcugan')
  for (const name of ['models-se', 'models-pro', 'models']) {
    const dir = path.join(base, name)
    if (fs.existsSync(dir)) return dir
  }
  return null
}

function getFFmpegPath() {
  return resolveBinary('ffmpeg', 'ffmpeg')
}

/** 临时工作目录：放在系统 temp 下，避免污染用户素材目录 */
function workDir(taskId) {
  const root = path.join(app.getPath('temp'), 'omni-upscale', taskId)
  fs.mkdirSync(root, { recursive: true })
  return root
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 进程可能仍持有句柄，忽略 */
  }
}

module.exports = {
  runtimeRoot,
  getEsrganPath,
  getEsrganModelsDir,
  getCuganPath,
  getCuganModelsDir,
  getFFmpegPath,
  workDir,
  removeDir
}
