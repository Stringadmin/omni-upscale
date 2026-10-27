'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow, Menu, shell, dialog, screen } = require('electron')

const { registerIpc, getQueue } = require('./ipc')
const settings = require('./settings')

const isDev = process.argv.includes('--dev')
const isSmoke = process.argv.includes('--smoke')
const isSelfTest = process.argv.includes('--selftest')

app.setAppUserModelId('com.omniai.upscale')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

let mainWindow = null

/** 换过显示器后旧坐标可能落在屏幕外，这里做一次可见性校验 */
function safeBounds(saved) {
  if (!saved || !saved.width) return null
  try {
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return (
        saved.x < area.x + area.width - 120 &&
        saved.x + saved.width > area.x + 120 &&
        saved.y < area.y + area.height - 80 &&
        saved.y + saved.height > area.y
      )
    })
    return visible ? saved : { width: saved.width, height: saved.height }
  } catch {
    return { width: saved.width, height: saved.height }
  }
}

function createWindow() {
  const stored = settings.read()
  const saved = safeBounds(stored.windowBounds)
  const preferred = saved && saved.width > 600 ? saved : { width: 1280, height: 840 }

  // 默认窗口偏大，但要保证在小屏（1366×768）上不会超出可用区域
  const work = screen.getPrimaryDisplay().workAreaSize
  const bounds = {
    width: Math.min(preferred.width, Math.round(work.width * 0.94)),
    height: Math.min(preferred.height, Math.round(work.height * 0.94)),
    x: preferred.x,
    y: preferred.y
  }

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0c10',
    title: 'Omni Upscale',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSmoke && !isSelfTest) mainWindow.show()
  })

  mainWindow.on('resize', persistBounds)
  mainWindow.on('move', persistBounds)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接一律交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 禁止拖拽文件时页面被导航成文件本身
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })

  mainWindow.webContents.on('console-message', (...args) => {
    if (!isSmoke && !isSelfTest) return
    const message = args
      .map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
      .join(' ')
    console.log(`CONSOLE ${message}`)
  })

  const target = path.join(__dirname, '../renderer/index.html')
  mainWindow.loadFile(target)

  mainWindow.webContents.once('did-finish-load', () => {
    // 页面加载后再设一次，导航会重置缩放
    const scale = Number(settings.read().uiScale) || 1.12
    mainWindow.webContents.setZoomFactor(scale)

    if (isSmoke) runSmoke()
    if (isSelfTest) runSelfTest()
    if (process.argv.includes('--shot')) captureShot()
  })

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

/* ── 自动化检查（--smoke / --selftest）───────────────────────── */

async function runSmoke() {
  try {
    // 等渲染层 init 完成，并等后台算力探测出结果（最多 20 秒）
    await new Promise((resolve) => setTimeout(resolve, 900))
    await mainWindow.webContents
      .executeJavaScript(
        `new Promise((resolve) => {
          const started = Date.now()
          const timer = setInterval(() => {
            if (window.__omniProbe || Date.now() - started > 20000) {
              clearInterval(timer)
              resolve(true)
            }
          }, 200)
        })`
      )
      .catch(() => {})
    const result = await mainWindow.webContents.executeJavaScript(`(async () => {
      const info = await window.omni.info()
      const engines = Object.fromEntries(
        Object.entries(info.engines).map(([key, value]) => [key, Boolean(value.available)])
      )
      return {
        api: typeof window.omni === 'object',
        engines,
        controls: {
          runBtn: Boolean(document.querySelector('#runBtn')),
          queue: Boolean(document.querySelector('#queueBody')),
          modeSwitch: document.querySelectorAll('#modeSwitch .switch__btn').length,
          pills: document.querySelectorAll('.status__item').length
        },
        probe: window.__omniProbe || null,
        errors: window.__omniErrors || []
      }
    })()`)
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`)
  } catch (error) {
    console.log(`SMOKE_FAIL ${error?.message || error}`)
  } finally {
    setTimeout(() => app.exit(0), 200)
  }
}

async function captureShot() {
  try {
    await new Promise((resolve) => setTimeout(resolve, 900))

    // --size=960x640 用于检查自适应布局
    const sizeArg = process.argv.find((arg) => arg.startsWith('--size='))
    if (sizeArg) {
      const [width, height] = sizeArg.split('=')[1].split('x').map(Number)
      if (width > 400 && height > 300) {
        const bounds = mainWindow.getBounds()
        mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height })
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    if (process.argv.includes('--dark-mode')) {
      await mainWindow.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-theme','dark'); true`
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    if (process.argv.includes('--video-mode')) {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('[data-mode="video"]')?.click(); true`
      )
      await new Promise((resolve) => setTimeout(resolve, 400))
    }

    if (process.argv.includes('--with-video')) {
      const queue = getQueue()
      const workRoot = path.join(os.tmpdir(), 'omni-shot-video')
      fs.mkdirSync(workRoot, { recursive: true })
      const input = path.join(workRoot, 'player-sample.mp4')
      if (!fs.existsSync(input)) {
        const { runProcess } = require('./procs')
        await runProcess({
          command: require('./paths').getFFmpegPath(),
          args: [
            '-hide_banner',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=640x360:rate=24:duration=3',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=3',
            '-c:v',
            'libx264',
            '-c:a',
            'aac',
            '-pix_fmt',
            'yuv420p',
            '-shortest',
            '-y',
            input
          ],
          timeoutMs: 60_000
        })
      }

      const added = queue.add([input], {
        mode: 'video',
        engine: 'ffmpeg',
        model: 'realesr-animevideov3',
        scale: 2,
        noise: 0,
        imageFormat: 'png',
        quality: 'standard',
        videoTarget: 'longEdge',
        longEdge: 1080,
        outputMode: 'folder',
        outputDir: workRoot,
        tileSize: 0
      })
      if (added.length) {
        const id = added[0].id
        queue.start()
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            const task = queue.tasks.find((item) => item.id === id)
            if (task && ['done', 'error', 'cancelled'].includes(task.status)) {
              clearInterval(timer)
              resolve()
            }
          }, 300)
        })
        await new Promise((resolve) => setTimeout(resolve, 600))
        await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.task')?.click(); true`
        )
        await new Promise((resolve) => setTimeout(resolve, 1800))
      }
    }

    if (process.argv.includes('--with-task')) {
      const queue = getQueue()
      const workRoot = path.join(os.tmpdir(), 'omni-shot-work')
      fs.mkdirSync(workRoot, { recursive: true })
      const input = path.join(workRoot, 'preview-sample.png')
      fs.copyFileSync(path.join(app.getAppPath(), 'build', 'icon.png'), input)

      const added = queue.add([input], {
        mode: 'image',
        engine: 'esrgan',
        model: 'realesr-animevideov3',
        scale: 2,
        noise: 0,
        imageFormat: 'png',
        quality: 'standard',
        videoTarget: 'longEdge',
        longEdge: 1080,
        outputMode: 'folder',
        outputDir: workRoot,
        tileSize: 0
      })
      if (added.length) {
        const id = added[0].id
        queue.start()
        await Promise.race([
          new Promise((resolve) => {
            const timer = setInterval(() => {
              const task = queue.tasks.find((item) => item.id === id)
              if (task && ['done', 'error', 'cancelled'].includes(task.status)) {
                clearInterval(timer)
                resolve()
              }
            }, 250)
          }),
          new Promise((resolve) => setTimeout(resolve, 30000))
        ])
        const snapshot = queue.tasks.find((item) => item.id === id)
        console.log(
          `TASK_STATE ${snapshot?.status} ${Math.round((snapshot?.progress || 0) * 100)}% | ${(snapshot?.logs || []).slice(-4).join(' // ')}`
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.task')?.click(); true`
        )
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
    }

    // --open=settings / --open=task 用于截取弹窗
    const openArg = process.argv.find((arg) => arg.startsWith('--open='))
    if (openArg) {
      // 等算力探测出结果，否则环境列表停在「检测中」
      await mainWindow.webContents
        .executeJavaScript(
          `new Promise((resolve) => {
            const started = Date.now()
            const timer = setInterval(() => {
              if (window.__omniProbe || Date.now() - started > 15000) {
                clearInterval(timer)
                resolve(true)
              }
            }, 200)
          })`
        )
        .catch(() => {})
      const which = openArg.split('=')[1]
      const script =
        which === 'task'
          ? `document.querySelector('[data-action="info"]')?.click(); true`
          : `document.querySelector('#moreBtn')?.click(); true`
      await mainWindow.webContents.executeJavaScript(script)
      await new Promise((resolve) => setTimeout(resolve, 700))
    }

    const image = await mainWindow.webContents.capturePage()
    const target = path.join(os.tmpdir(), 'omni-shot.png')
    fs.writeFileSync(target, image.toPNG())
    console.log(`SHOT ${target}`)
  } catch (error) {
    console.log(`SHOT_FAIL ${error?.message || error}`)
  } finally {
    app.exit(0)
  }
}

async function runSelfTest() {
  const queue = getQueue()
  const wantVideo = process.argv.includes('--video')
  const workRoot = path.join(os.tmpdir(), 'omni-selftest')
  fs.mkdirSync(workRoot, { recursive: true })

  const baseOptions = {
    mode: wantVideo ? 'video' : 'image',
    engine: 'esrgan',
    model: 'realesr-animevideov3',
    scale: 2,
    noise: 0,
    imageFormat: 'png',
    quality: 'standard',
    videoTarget: 'longEdge',
    longEdge: 1080,
    outputMode: 'folder',
    outputDir: workRoot,
    tileSize: 0
  }

  const waitAll = (ids) =>
    new Promise((resolve) => {
      const timer = setInterval(() => {
        const tasks = ids.map((id) => queue.tasks.find((item) => item.id === id))
        const finished = tasks.every(
          (task) => task && ['done', 'error', 'cancelled'].includes(task.status)
        )
        if (!finished) return
        clearInterval(timer)
        resolve(
          tasks.map((task) => ({
            status: task.status,
            output: task.output,
            size: task.outputSize,
            dims: task.outWidth ? `${task.outWidth}x${task.outHeight}` : '',
            warning: task.warning || '',
            error: task.error,
            ms: task.finishedAt - task.startedAt
          }))
        )
      }, 250)
    })

  try {
    const { runProcess } = require('./procs')
    const ffmpegPath = require('./paths').getFFmpegPath()
    // --file 可以直接指定被试文件，方便针对特定素材跑验证
    const fileIdx = process.argv.indexOf('--file')
    const customFile = fileIdx > 0 ? process.argv[fileIdx + 1] : null
    let input = customFile || path.join(workRoot, 'sample.png')

    if (customFile) {
      if (!fs.existsSync(customFile)) throw new Error(`测试文件不存在: ${customFile}`)
    } else if (wantVideo) {
      input = path.join(workRoot, 'sample.mp4')
      if (!fs.existsSync(input)) {
        await runProcess({
          command: ffmpegPath,
          args: [
            '-hide_banner',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=320x240:rate=12:duration=2',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=2',
            '-c:v',
            'libx264',
            '-c:a',
            'aac',
            '-pix_fmt',
            'yuv420p',
            '-shortest',
            '-y',
            input
          ],
          timeoutMs: 60_000
        })
      }
    } else if (!fs.existsSync(input)) {
      // 用 ffmpeg 现造一张带细节的测试图，打包后也能自检
      await runProcess({
        command: ffmpegPath,
        args: [
          '-hide_banner',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=768x768:duration=1',
          '-frames:v',
          '1',
          '-y',
          input
        ],
        timeoutMs: 60_000
      })
    }

    const runs = wantVideo
      ? [
          { engine: 'ffmpeg', label: 'fast' },
          { engine: 'esrgan', label: 'esrgan' }
        ]
      : [
          { engine: 'esrgan', label: 'esrgan' },
          { engine: 'ffmpeg', label: 'resample' }
        ]

    const report = {}
    for (const run of runs) {
      const added = queue.add([input], { ...baseOptions, engine: run.engine })
      if (!added.length) {
        report[run.label] = { status: 'add-failed' }
        continue
      }
      const ids = added.map((task) => task.id)
      queue.start()
      const [result] = await waitAll(ids)
      report[run.label] = result
    }

    console.log(`SELFTEST_RESULT ${JSON.stringify(report)}`)
    app.exit(0)
  } catch (error) {
    console.log(`SELFTEST_FAIL ${error?.message || error}`)
    app.exit(1)
  }
}

let persistTimer = null
function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      settings.write({ windowBounds: mainWindow.getBounds() })
    } catch {
      /* ignore */
    }
  }, 500)
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前把还在跑的任务掐掉，避免遗留 ffmpeg/esrgan 进程占着显卡
app.on('before-quit', () => {
  try {
    getQueue().cancelAll()
  } catch {
    /* ignore */
  }
})

process.on('uncaughtException', (error) => {
  if (!app.isReady() || !mainWindow) return
  dialog.showErrorBox('Omni Upscale 发生错误', error?.stack || String(error))
})
