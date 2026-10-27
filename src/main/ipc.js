'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, dialog, ipcMain, shell, BrowserWindow } = require('electron')

const esrgan = require('./engines/esrgan')
const cugan = require('./engines/cugan')
const ffmpegEngine = require('./engines/ffmpeg')
const { TaskQueue, kindOf } = require('./tasks')
const settings = require('./settings')

let queue = null

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function getQueue() {
  if (queue) return queue
  queue = new TaskQueue({
    onUpdate: (tasks) => broadcast('queue:update', tasks),
    onLog: (entry) => broadcast('queue:log', entry)
  })
  return queue
}

function registerIpc() {
  const q = getQueue()

  // preload 在页面首帧前同步取主题，避免亮/暗切换时的白闪
  ipcMain.on('theme:sync', (event) => {
    event.returnValue = settings.read().theme || 'system'
  })

  ipcMain.handle('app:info', async () => {
    const nvenc = await ffmpegEngine.detectNvenc().catch(() => false)
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      engines: {
        esrgan: esrgan.status(),
        cugan: cugan.status(),
        ffmpeg: {
          id: 'ffmpeg',
          name: 'FFmpeg',
          available: Boolean(require('./paths').getFFmpegPath()),
          hardwareEncode: nvenc
        }
      },
      settings: settings.read()
    }
  })

  ipcMain.handle('dialog:files', async (_event, kind) => {
    const filters =
      kind === 'video'
        ? [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mpg', 'mpeg'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] }]

    const result = await dialog.showOpenDialog({
      title: kind === 'video' ? '选择视频文件' : '选择图片文件',
      properties: ['openFile', 'multiSelections'],
      filters: [...filters, { name: '全部文件', extensions: ['*'] }]
    })
    if (result.canceled) return []
    return result.filePaths.filter((file) => kindOf(file) === kind)
  })

  ipcMain.handle('dialog:outputDir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('settings:save', async (_event, patch) => settings.write(patch || {}))

  ipcMain.handle('ui:setScale', async (_event, factor) => {
    const value = Number(factor)
    if (!Number.isFinite(value) || value < 0.8 || value > 1.6) return settings.read().uiScale
    settings.write({ uiScale: value })
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.setZoomFactor(value)
    }
    return value
  })

  /**
   * 真实算力探测：ncnn-vulkan 没有 CPU 回退，必须实际跑一次才知道能不能用。
   * 结果在进程内缓存，force=true 时重新检测（用户装了驱动可以用）。
   */
  ipcMain.handle('engine:probe', async (_event, payload) => {
    if (payload?.force) esrgan.resetProbe()
    const esrganProbe = await esrgan.probeRuntime()
    return { esrgan: esrganProbe }
  })

  ipcMain.handle('queue:add', async (_event, { paths, options }) => {
    const list = (paths || []).filter((file) => {
      try {
        return fs.statSync(file).isFile() && kindOf(file)
      } catch {
        return false
      }
    })
    return q.add(list, options)
  })

  ipcMain.handle('queue:list', async () => q.list())
  ipcMain.handle('queue:start', async () => q.start())
  ipcMain.handle('queue:cancel', async (_event, id) => q.cancel(id))
  ipcMain.handle('queue:cancelAll', async () => q.cancelAll())
  ipcMain.handle('queue:remove', async (_event, id) => q.remove(id))
  ipcMain.handle('queue:clearFinished', async () => q.clearFinished())
  ipcMain.handle('queue:logs', async (_event, id) => q.logsOf(id))

  ipcMain.handle('shell:openPath', async (_event, target) => {
    if (!target || !fs.existsSync(target)) return false
    await shell.openPath(target)
    return true
  })

  ipcMain.handle('shell:showItem', async (_event, target) => {
    if (!target || !fs.existsSync(target)) return false
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle('media:reveal', async (_event, target) => {
    if (!target) return false
    try {
      const stat = fs.statSync(target)
      if (stat.isDirectory()) shell.openPath(target)
      else shell.showItemInFolder(target)
      return true
    } catch {
      return false
    }
  })

  /** 拖入文件时校验可处理类型，返回有效路径与无效项 */
  ipcMain.handle('files:validate', async (_event, paths) => {
    const valid = []
    const skipped = []
    for (const file of paths || []) {
      const kind = kindOf(file)
      if (!kind) {
        skipped.push(path.basename(file))
        continue
      }
      try {
        if (fs.statSync(file).isFile()) valid.push({ path: file, kind })
        else skipped.push(path.basename(file))
      } catch {
        skipped.push(path.basename(file))
      }
    }
    return { valid, skipped }
  })

  ipcMain.handle('file:stat', async (_event, target) => {
    try {
      const stat = fs.statSync(target)
      return { size: stat.size, mtime: stat.mtimeMs }
    } catch {
      return null
    }
  })
}

module.exports = { registerIpc, getQueue }
