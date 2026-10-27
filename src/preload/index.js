'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * sandbox 模式下 preload 拿不到 node:path，这里用纯字符串实现。
 * Windows 与 POSIX 的分隔符都兼容。
 */
function basename(target) {
  if (!target) return ''
  const parts = String(target).replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || ''
}

function extname(target) {
  const name = basename(target)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

/**
 * 在页面首帧渲染前落定主题，避免深色启动时闪白。
 */
function applyInitialTheme() {
  try {
    const mode = ipcRenderer.sendSync('theme:sync')
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = mode === 'system' ? prefersDark : mode === 'dark'
    const root = document.documentElement
    if (root) root.setAttribute('data-theme', dark ? 'dark' : 'light')
  } catch {
    /* 拿不到配置时沿用 HTML 默认的暗色 */
  }
}

applyInitialTheme()

/**
 * 拖拽进来的 File 对象无法跨 context 序列化，只能在 preload 侧用
 * webUtils.getPathForFile 换出真实路径，再通过自定义事件交给页面。
 */
window.addEventListener('dragover', (event) => {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})

window.addEventListener('drop', (event) => {
  if (!event.dataTransfer) return
  event.preventDefault()
  const paths = []
  for (const file of event.dataTransfer.files) {
    try {
      const real = webUtils.getPathForFile(file)
      if (real) paths.push(real)
    } catch {
      /* 某些来源（如浏览器拖拽）没有真实路径，忽略 */
    }
  }
  if (paths.length) window.dispatchEvent(new CustomEvent('omni:drop', { detail: paths }))
})

function toFileUrl(target) {
  if (!target) return ''
  const normalized = target.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

contextBridge.exposeInMainWorld('omni', {
  info: () => ipcRenderer.invoke('app:info'),
  pickFiles: (kind) => ipcRenderer.invoke('dialog:files', kind),
  pickOutputDir: () => ipcRenderer.invoke('dialog:outputDir'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  probeEngines: (options) => ipcRenderer.invoke('engine:probe', options || {}),
  setUiScale: (factor) => ipcRenderer.invoke('ui:setScale', factor),

  validateFiles: (paths) => ipcRenderer.invoke('files:validate', paths),
  statFile: (target) => ipcRenderer.invoke('file:stat', target),

  addTasks: (paths, options) => ipcRenderer.invoke('queue:add', { paths, options }),
  listTasks: () => ipcRenderer.invoke('queue:list'),
  start: () => ipcRenderer.invoke('queue:start'),
  cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
  cancelAll: () => ipcRenderer.invoke('queue:cancelAll'),
  remove: (id) => ipcRenderer.invoke('queue:remove', id),
  clearFinished: () => ipcRenderer.invoke('queue:clearFinished'),
  taskLogs: (id) => ipcRenderer.invoke('queue:logs', id),

  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  reveal: (target) => ipcRenderer.invoke('media:reveal', target),

  toFileUrl,
  basename,
  extname,

  onQueueUpdate: (callback) => {
    const listener = (_event, tasks) => callback(tasks)
    ipcRenderer.on('queue:update', listener)
    return () => ipcRenderer.removeListener('queue:update', listener)
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry)
    ipcRenderer.on('queue:log', listener)
    return () => ipcRenderer.removeListener('queue:log', listener)
  },
  onDrop: (callback) => {
    const listener = (event) => callback(event.detail || [])
    window.addEventListener('omni:drop', listener)
    return () => window.removeEventListener('omni:drop', listener)
  }
})
