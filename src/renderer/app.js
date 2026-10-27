import { computePosition, offset, flip, shift } from './vendor/floating-ui.dom.mjs'
import Plyr from './vendor/plyr.mjs'

const api = window.omni

// 收集渲染层未捕获异常，便于自动化自检定位问题
window.__omniErrors = []
window.addEventListener('error', (event) => {
  window.__omniErrors.push(String(event.message || event.error))
})
window.addEventListener('unhandledrejection', (event) => {
  window.__omniErrors.push(String(event.reason))
})

const ENGINE_LABEL = { esrgan: 'Real-ESRGAN', cugan: 'Real-CUGAN', ffmpeg: 'FFmpeg 快速' }
const MODE_LABEL = { image: '图片', video: '视频' }

const QUALITY_OPTIONS = [
  { value: 'high', label: '高' },
  { value: 'standard', label: '标准' },
  { value: 'small', label: '小' }
]

const LONG_EDGE_OPTIONS = [1080, 1440, 2160, 4320]
const FORMAT_OPTIONS = ['png', 'jpg', 'webp']
const UI_SCALES = [0.9, 1, 1.12, 1.25, 1.4]
const DEFAULT_UI_SCALE = 1.12

const state = {
  info: null,
  settings: {},
  tasks: [],
  selectedId: null,
  compareSplit: 50,
  saveTimer: null,
  // null = 尚未探测；{ ok, reason } = 实际跑过一次的结论
  probe: { esrgan: null }
}

const el = (id) => document.getElementById(id)

/* ────────────────────── 工具 ────────────────────── */

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function escapeHtml(text) {  return String(text ?? '').replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  })
}

function toast(message, type = 'info') {
  const node = document.createElement('div')
  node.className = `toast${type === 'error' ? ' toast--error' : ''}`
  node.textContent = message
  el('toastLayer').appendChild(node)
  setTimeout(
    () => {
      node.style.transition = 'opacity .18s'
      node.style.opacity = '0'
      setTimeout(() => node.remove(), 200)
    },
    type === 'error' ? 4200 : 2400
  )
}

function currentMode() {
  return state.settings.mode || 'image'
}

function engineStatus(id) {
  return state.info?.engines?.[id] || null
}

function availableEngines(mode) {
  // 图片也保留 FFmpeg：没有 Vulkan 的机器（老核显 / 虚拟机 / 服务器）靠它兜底
  return mode === 'image' ? ['esrgan', 'cugan', 'ffmpeg'] : ['ffmpeg', 'esrgan', 'cugan']
}

/**
 * 引擎是否真的能用。
 *
 * esrgan 除了文件齐全，还要求机器有可用 Vulkan —— ncnn-vulkan 没有 CPU 回退，
 * 探测失败就必须禁用，否则用户点了只会得到一句看不懂的报错。
 */
function engineUsable(id) {
  const status = engineStatus(id)
  if (!status?.available) return false
  if (id === 'esrgan' && state.probe.esrgan && state.probe.esrgan.ok === false) return false
  return true
}

function engineUnavailableReason(id) {
  if (id === 'esrgan' && state.probe.esrgan && state.probe.esrgan.ok === false) {
    return state.probe.esrgan.reason || '显卡不支持 Vulkan'
  }
  return engineStatus(id)?.reason || ''
}

function persist() {
  if (state.saveTimer) clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(() => {
    api.saveSettings(state.settings).catch(() => {})
  }, 320)
}

/* ────────────────────── 主题 ────────────────────── */

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

let themeAnimTimer = null

function applyTheme(animate = false) {
  if (animate) {
    document.documentElement.classList.add('theme-anim')
    if (themeAnimTimer) clearTimeout(themeAnimTimer)
    themeAnimTimer = setTimeout(() => {
      document.documentElement.classList.remove('theme-anim')
    }, 280)
  }

  const mode = state.settings.theme || 'system'
  const dark = mode === 'system' ? prefersDark() : mode === 'dark'
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  const btn = el('themeBtn')
  btn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon')
  btn.dataset.tip = dark ? '切换到亮色' : '切换到暗色'
}

/* ────────────────────── Tooltip（Floating UI） ────────────────────── */

let tooltipEl = null
let tooltipTimer = null

function ensureTooltip() {
  if (tooltipEl) return tooltipEl
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'tooltip'
  document.body.appendChild(tooltipEl)
  return tooltipEl
}

async function showTooltip(anchor, text) {
  const tip = ensureTooltip()
  tip.textContent = text
  tip.classList.add('is-visible')
  const { x, y } = await computePosition(anchor, tip, {
    placement: 'top',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })]
  })
  tip.style.left = `${Math.round(x)}px`
  tip.style.top = `${Math.round(y)}px`
}

function hideTooltip() {
  if (tooltipTimer) clearTimeout(tooltipTimer)
  tooltipTimer = null
  if (tooltipEl) tooltipEl.classList.remove('is-visible')
}

function initTooltips() {
  document.addEventListener('pointerover', (event) => {
    const anchor = event.target.closest?.('[data-tip]')
    if (!anchor || !anchor.dataset.tip) return
    hideTooltip()
    tooltipTimer = setTimeout(() => showTooltip(anchor, anchor.dataset.tip), 420)
  })

  document.addEventListener('pointerout', (event) => {
    if (!event.target.closest?.('[data-tip]')) return
    hideTooltip()
  })

  document.addEventListener('pointerdown', hideTooltip)
  window.addEventListener('blur', hideTooltip)
}

/* ────────────────────── 引擎状态 ────────────────────── */

function renderStatus() {
  const parts = []
  for (const id of ['esrgan', 'cugan', 'ffmpeg']) {
    const status = engineStatus(id)
    if (!status) continue
    const on = engineUsable(id)
    const title = on ? '可用' : engineUnavailableReason(id) || '不可用'
    parts.push(
      `<span class="status__item ${on ? 'is-on' : 'is-off'}" data-tip="${escapeHtml(title)}">
        <span class="status__dot"></span>${ENGINE_LABEL[id]}
      </span>`
    )
  }
  el('statusPills').innerHTML = parts.join('')
}

/* ────────────────────── 参数渲染 ────────────────────── */

function renderModeSwitch() {
  const mode = currentMode()
  for (const btn of el('modeSwitch').querySelectorAll('.switch__btn')) {
    btn.classList.toggle('is-active', btn.dataset.mode === mode)
  }
}

function renderEngines() {
  const mode = currentMode()
  const ids = availableEngines(mode)
  const usableIds = ids.filter(engineUsable)
  const keep = usableIds.includes(state.settings.engine) ? state.settings.engine : usableIds[0] || ids[0]
  state.settings.engine = keep

  const select = el('engineSelect')
  select.innerHTML = ids
    .map((id) => {
      const usable = engineUsable(id)
      const suffix = usable ? '' : ' · 不可用'
      return `<option value="${id}"${usable ? '' : ' disabled'}>${ENGINE_LABEL[id]}${suffix}</option>`
    })
    .join('')
  select.value = keep

  el('modelSelect').hidden = keep !== 'esrgan'
  // 只有视频的 FFmpeg 模式改用目标分辨率，图片仍然按倍数缩放
  el('scaleChips').parentElement.hidden = mode === 'video' && keep === 'ffmpeg'
  el('longEdgeGroup').hidden = !(mode === 'video' && keep === 'ffmpeg')

  // 弹层里的字段
  el('noiseField').hidden = keep !== 'cugan'
  el('formatField').hidden = mode !== 'image'
  el('qualityField').hidden = mode !== 'video'
}

function renderModels() {
  const models = engineStatus('esrgan')?.models || []
  const usable = models.filter((model) => model.available)
  const list = usable.length ? usable : models

  if (!list.some((model) => model.id === state.settings.model)) {
    state.settings.model = list[0]?.id || ''
  }

  const select = el('modelSelect')
  select.innerHTML = list
    .map(
      (model) =>
        `<option value="${model.id}"${model.available ? '' : ' disabled'}>${model.label}</option>`
    )
    .join('')
  select.value = state.settings.model
  select.disabled = list.every((model) => !model.available)
  select.title = list.find((model) => model.id === state.settings.model)?.hint || ''

  renderScales()
}

function activeModel() {
  return engineStatus('esrgan')?.models?.find((model) => model.id === state.settings.model) || null
}

function renderScales() {
  const host = el('scaleChips')
  const engine = state.settings.engine
  const model = activeModel()

  let scales = [2, 3, 4]
  if (engine === 'esrgan' && model) scales = model.scales
  if (!scales.includes(state.settings.scale)) state.settings.scale = scales[0]

  host.innerHTML = scales
    .map(
      (scale) =>
        `<button type="button" class="seg__btn${scale === state.settings.scale ? ' is-active' : ''}" data-scale="${scale}">${scale}x</button>`
    )
    .join('')

  host.querySelectorAll('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.scale = Number(btn.dataset.scale)
      renderScales()
      persist()
    })
  })
}

function renderLongEdge() {
  const host = el('longEdgeChips')
  host.innerHTML = LONG_EDGE_OPTIONS.map(
    (edge) =>
      `<button type="button" class="seg__btn${edge === state.settings.longEdge ? ' is-active' : ''}" data-edge="${edge}">${edge}p</button>`
  ).join('')

  host.querySelectorAll('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.longEdge = Number(btn.dataset.edge)
      renderLongEdge()
      persist()
    })
  })
}

function renderNoise() {
  const levels = engineStatus('cugan')?.noiseLevels || []
  const host = el('noiseChips')
  host.innerHTML = levels
    .map(
      (level) =>
        `<button type="button" class="seg__btn${level.value === state.settings.noise ? ' is-active' : ''}" data-noise="${level.value}" title="${escapeHtml(level.hint)}">${level.label}</button>`
    )
    .join('')

  host.querySelectorAll('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.noise = Number(btn.dataset.noise)
      renderNoise()
      persist()
    })
  })
}

function renderFormat() {
  const host = el('formatChips')
  host.innerHTML = FORMAT_OPTIONS.map(
    (format) =>
      `<button type="button" class="seg__btn${format === state.settings.imageFormat ? ' is-active' : ''}" data-format="${format}">${format.toUpperCase()}</button>`
  ).join('')

  host.querySelectorAll('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.imageFormat = btn.dataset.format
      renderFormat()
      persist()
    })
  })
}

function renderQuality() {
  const host = el('qualityChips')
  host.innerHTML = QUALITY_OPTIONS.map(
    (option) =>
      `<button type="button" class="seg__btn${option.value === state.settings.quality ? ' is-active' : ''}" data-quality="${option.value}">${option.label}</button>`
  ).join('')

  host.querySelectorAll('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.quality = btn.dataset.quality
      renderQuality()
      persist()
    })
  })
}

function renderOutputMode() {
  for (const btn of el('outputModeChips').querySelectorAll('.seg__btn')) {
    btn.classList.toggle('is-active', btn.dataset.output === state.settings.outputMode)
  }
  const isFolder = state.settings.outputMode === 'folder'
  const pathBtn = el('pickDirBtn')
  pathBtn.hidden = !isFolder
  if (isFolder) {
    el('dirPath').textContent = state.settings.outputDir || '选择目录'
  }
}

function collectOptions() {
  return {
    mode: currentMode(),
    engine: state.settings.engine,
    model: state.settings.model,
    scale: Number(state.settings.scale),
    noise: Number(state.settings.noise),
    imageFormat: state.settings.imageFormat,
    quality: state.settings.quality,
    videoTarget: state.settings.videoTarget,
    longEdge: state.settings.longEdge,
    outputMode: state.settings.outputMode,
    outputDir: state.settings.outputDir,
    tileSize: state.settings.tileSize
  }
}

/* ────────────────────── 队列 ────────────────────── */

function renderQueueControls() {
  const tasks = state.tasks
  const pending = tasks.filter((task) => task.status === 'pending').length
  const running = tasks.filter((task) => task.status === 'running').length
  const done = tasks.filter((task) => task.status === 'done').length

  const runBtn = el('runBtn')
  const label = runBtn.querySelector('span')
  if (running > 0) {
    label.textContent = `处理中 ${Math.round(tasks.find((t) => t.status === 'running')?.progress || 0)}%`
    runBtn.disabled = true
  } else if (pending > 0) {
    label.textContent = `开始超分 · ${pending}`
    runBtn.disabled = false
  } else {
    label.textContent = '开始超分'
    runBtn.disabled = true
  }

  runBtn.classList.toggle('is-ready', running === 0 && pending > 0)
  el('queue').hidden = tasks.length === 0
  el('clearBtn').hidden = done === 0
  el('queueCount').textContent = String(tasks.length)
}

function taskMetaLine(task) {
  if (task.status === 'error') return { text: task.error || '处理失败', cls: 'task__meta task__meta--error' }
  if (task.status === 'running') return { text: `${task.phase} · ${fmtBytes(task.inputSize)}`, cls: 'task__meta' }
  if (task.status === 'done') {
    const dims = task.outWidth ? `${task.outWidth}×${task.outHeight} · ` : ''
    const text = `${dims}${fmtBytes(task.inputSize)} → ${fmtBytes(task.outputSize)} · ${fmtDuration(task.elapsedMs)}`
    if (task.warning) return { text: `！${task.warning}`, cls: 'task__meta task__meta--warn' }
    return { text, cls: 'task__meta' }
  }
  if (task.status === 'cancelled') return { text: '已取消', cls: 'task__meta' }
  return { text: `${fmtBytes(task.inputSize)} · 等待中`, cls: 'task__meta' }
}

function statusText(task) {
  return { pending: '排队', running: '处理中', done: '完成', error: '失败', cancelled: '取消' }[task.status] || ''
}

let queueSignature = ''

function renderTasks() {
  const body = el('queueBody')
  const tasks = state.tasks

  if (!tasks.length) {
    body.innerHTML = ''
    queueSignature = ''
    renderQueueControls()
    return
  }

  // 运行中每 120ms 推一次进度，状态组合未变时只更新进度，避免整表重建
  const signature = tasks.map((task) => `${task.id}:${task.status}`).join('|')
  if (signature === queueSignature) {
    updateProgressOnly()
    renderQueueControls()
    return
  }
  queueSignature = signature

  body.innerHTML = tasks
    .map((task) => {
      const meta = taskMetaLine(task)
      const thumb =
        task.kind === 'image'
          ? `<img src="${api.toFileUrl(task.input)}" alt="" />`
          : `<svg><use href="#i-video" /></svg>`
      const barClass =
        task.status === 'done'
          ? 'task__bar is-done'
          : task.status === 'error'
            ? 'task__bar is-error'
            : 'task__bar'
      const pct = task.status === 'done' ? 100 : Math.round(task.progress)

      return `<div class="task${task.id === state.selectedId ? ' is-selected' : ''}" data-id="${task.id}">
        <div class="task__thumb">${thumb}</div>
        <div class="task__main">
          <div class="task__name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</div>
          <div class="${meta.cls}" title="${escapeHtml(meta.text)}">${escapeHtml(meta.text)}</div>
        </div>
        <div class="task__progress">
          <div class="${barClass}"><span style="width:${pct}%"></span></div>
          <div class="task__pct">${statusText(task)} ${task.status === 'running' || task.status === 'done' ? `${pct}%` : ''}</div>
        </div>
        <div class="task__act">
          <button type="button" class="icon-btn" data-action="info" data-tip="任务详情"><svg><use href="#i-info" /></svg></button>
          ${task.status === 'done' ? '<button type="button" class="icon-btn" data-action="reveal" data-tip="在文件夹中显示"><svg><use href="#i-external-link" /></svg></button>' : ''}
          ${task.status === 'running' || task.status === 'pending' ? '<button type="button" class="icon-btn" data-action="cancel" data-tip="取消"><svg><use href="#i-square" /></svg></button>' : ''}
          ${task.status !== 'running' ? '<button type="button" class="icon-btn" data-action="remove" data-tip="移除"><svg><use href="#i-x" /></svg></button>' : ''}
        </div>
      </div>`
    })
    .join('')

  body.querySelectorAll('.task').forEach((row) => {
    const id = row.dataset.id
    row.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action
      if (action) {
        event.stopPropagation()
        handleTaskAction(action, id)
        return
      }
      selectTask(id)
    })
  })

  renderQueueControls()
}

function updateProgressOnly() {
  for (const task of state.tasks) {
    const row = document.querySelector(`.task[data-id="${task.id}"]`)
    if (!row) continue
    const pct = task.status === 'done' ? 100 : Math.round(task.progress)
    const bar = row.querySelector('.task__bar span')
    if (bar) bar.style.width = `${pct}%`
    const pctEl = row.querySelector('.task__pct')
    if (pctEl) {
      pctEl.textContent = `${statusText(task)} ${task.status === 'running' || task.status === 'done' ? `${pct}%` : ''}`
    }
    const meta = taskMetaLine(task)
    const metaEl = row.querySelector('.task__meta, .task__meta--error, .task__meta--warn')
    if (metaEl) {
      metaEl.className = meta.cls
      metaEl.title = meta.text
      metaEl.textContent = meta.text
    }
  }
}

/** 任务完成的瞬时高亮，配合 CSS 的 done-flash */
function flashDone(id) {
  requestAnimationFrame(() => {
    const row = document.querySelector(`.task[data-id="${id}"]`)
    if (!row) return
    row.classList.add('is-just-done')
    setTimeout(() => row.classList.remove('is-just-done'), 760)
  })
}

async function handleTaskAction(action, id) {
  const task = state.tasks.find((item) => item.id === id)
  if (!task) return
  if (action === 'info') return openTaskDetail(id)
  if (action === 'cancel') return api.cancel(id)
  if (action === 'remove') {
    const ok = await api.remove(id)
    if (!ok) toast('正在处理的任务不能移除', 'error')
    if (state.selectedId === id) state.selectedId = null
    return
  }
  if (action === 'reveal') return api.reveal(task.output || task.input)
}

/* ────────────────────── 播放器（Plyr） ────────────────────── */

const PLYR_I18N = {
  restart: '重播',
  play: '播放',
  pause: '暂停',
  seek: '跳转',
  seekLabel: '{currentTime} / {duration}',
  played: '已播放',
  buffered: '已缓冲',
  currentTime: '当前时间',
  duration: '时长',
  volume: '音量',
  mute: '静音',
  unmute: '取消静音',
  enableCaptions: '开启字幕',
  disableCaptions: '关闭字幕',
  enterFullscreen: '全屏',
  exitFullscreen: '退出全屏',
  frameTitle: '播放器：{title}',
  captions: '字幕',
  settings: '设置',
  pip: '画中画',
  menuBack: '返回',
  speed: '播放速度',
  normal: '正常',
  quality: '画质',
  loop: '循环'
}

let player = null

function destroyPlayer() {
  if (!player) return
  try {
    player.destroy()
  } catch {
    /* 元素已被移除时忽略 */
  }
  player = null
}

function mountPlayer(src) {
  destroyPlayer()
  const video = document.createElement('video')
  video.src = src
  video.playsInline = true
  el('previewBody').replaceChildren(video)

  player = new Plyr(video, {
    controls: [
      'play-large',
      'play',
      'progress',
      'current-time',
      'duration',
      'mute',
      'volume',
      'settings',
      'pip',
      'fullscreen'
    ],
    settings: ['speed'],
    speed: { selected: 1, options: [0.5, 1, 1.5, 2] },
    keyboard: { focused: true, global: false },
    tooltips: { controls: true, seek: true },
    // 预览区控件常驻，避免静止时只剩一条进度条
    hideControls: false,
    clickToPlay: true,
    // 图标已内联到页面 sprite，禁止 Plyr 再去 CDN 拉 plyr.svg
    iconUrl: '',
    i18n: PLYR_I18N
  })
}

/* ────────────────────── 预览 ────────────────────── */

let previewKey = ''

function selectTask(id) {
  state.selectedId = state.selectedId === id ? null : id
  renderTasks()
  renderPreview(true)
}

function renderPreview(force = false) {
  const preview = el('preview')
  const dropzone = el('dropzone')
  const body = el('previewBody')
  const actions = el('previewActions')
  const title = el('previewTitle')

  const task = state.tasks.find((item) => item.id === state.selectedId)
  if (!task) {
    destroyPlayer()
    preview.hidden = true
    dropzone.hidden = false
    body.innerHTML = ''
    actions.innerHTML = ''
    previewKey = ''
    return
  }

  // 进度推送会高频触发刷新，视频元素一旦重建就会中断播放，这里按关键状态去重
  const key = `${task.id}|${task.status}|${task.output || ''}`
  if (!force && key === previewKey) return
  previewKey = key

  dropzone.hidden = true
  preview.hidden = false

  const dims = task.outWidth ? `${task.outWidth}×${task.outHeight}` : ''
  title.textContent =
    task.kind === 'image'
      ? `${task.name}${dims ? ` · ${dims}` : ''}`
      : `${task.name}${task.duration ? ` · ${task.duration.toFixed(1)}s` : ''}${dims ? ` · ${dims}` : ''}`

  const hasOutput = task.status === 'done' && task.output
  actions.innerHTML = hasOutput
    ? `<button type="button" class="icon-btn" data-preview="open" data-tip="打开文件"><svg><use href="#i-external-link" /></svg></button>
       <button type="button" class="icon-btn" data-preview="folder" data-tip="所在目录"><svg><use href="#i-folder-open" /></svg></button>`
    : `<button type="button" class="icon-btn" data-preview="folder" data-tip="所在目录"><svg><use href="#i-folder-open" /></svg></button>`

  actions.querySelectorAll('[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.preview === 'open') api.openPath(task.output)
      else api.reveal(hasOutput ? task.output : task.input)
    })
  })

  const originalUrl = api.toFileUrl(task.input)
  const resultUrl = hasOutput ? api.toFileUrl(task.output) : ''

  if (task.kind === 'video') {
    mountPlayer(hasOutput ? resultUrl : originalUrl)
    return
  }

  destroyPlayer()

  if (hasOutput) {
    body.innerHTML = `<div class="compare" id="compare" style="--split:${state.compareSplit}%">
      <img class="compare__img" src="${originalUrl}" alt="原图" />
      <img class="compare__img compare__img--top" src="${resultUrl}" alt="超分结果" />
      <div class="compare__divider"><div class="compare__handle"><svg><use href="#i-move-horizontal" /></svg></div></div>
      <span class="compare__tag compare__tag--left">原图</span>
      <span class="compare__tag compare__tag--right">超分 ${task.scale}x</span>
    </div>`
    bindCompare()
    return
  }

  body.innerHTML = `<img src="${originalUrl}" alt="" />`
}

function bindCompare() {
  const compare = el('compare')
  if (!compare) return
  let dragging = false

  const update = (clientX) => {
    const rect = compare.getBoundingClientRect()
    const split = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
    state.compareSplit = split
    compare.style.setProperty('--split', `${split}%`)
  }

  compare.addEventListener('pointerdown', (event) => {
    dragging = true
    compare.setPointerCapture(event.pointerId)
    update(event.clientX)
  })
  compare.addEventListener('pointermove', (event) => {
    if (dragging) update(event.clientX)
  })
  compare.addEventListener('pointerup', (event) => {
    dragging = false
    compare.releasePointerCapture(event.pointerId)
  })
}

/* ────────────────────── 导入 ────────────────────── */

async function addFiles(paths) {
  if (!paths?.length) return

  const { valid, skipped } = await api.validateFiles(paths)
  const mode = currentMode()
  const matched = valid.filter((item) => item.kind === mode)
  const wrongMode = valid.length - matched.length

  if (matched.length === 0) {
    if (wrongMode > 0) {
      toast(`当前是${MODE_LABEL[mode]}模式，${wrongMode} 个文件类型不匹配`, 'error')
    } else if (skipped.length) {
      toast(`不支持的文件：${skipped.slice(0, 3).join('、')}`, 'error')
    }
    return
  }

  const added = await api.addTasks(
    matched.map((item) => item.path),
    collectOptions()
  )

  if (!state.selectedId && added?.length) {
    state.selectedId = added[0].id
    renderPreview(true)
  }

  if (wrongMode > 0) {
    toast(`已加入 ${matched.length} 个，忽略 ${wrongMode} 个类型不匹配的文件`)
  }
  renderTasks()
}

/* ────────────────────── 算力探测 ────────────────────── */

/**
 * AI 超分依赖 Vulkan，ncnn-vulkan 没有 CPU 回退。启动时在后台真跑一次最小样例：
 * 成功就正常用，失败就把引擎置灰并自动切到 FFmpeg 快速模式。
 */
function handleProbe(result) {
  state.probe = { ...state.probe, ...result }
  window.__omniProbe = state.probe
  if (el('settingsDialog')?.open) renderEnv()
  renderStatus()
  renderEngines()
  renderModels()

  const esrgan = result?.esrgan
  if (!esrgan || esrgan.ok !== false) {
    if (esrgan?.ok) {
      toast(esrgan.slow ? `AI 超分可用，但性能较弱（自检 ${esrgan.elapsed}ms），建议优先用快速模式` : 'AI 超分引擎可用')
    }
    return
  }

  if (currentMode() === 'image' && state.settings.engine === 'esrgan') {
    state.settings.engine = 'ffmpeg'
    renderEngines()
    renderModels()
    persist()
  }
  toast(`AI 超分不可用：${esrgan.reason}。已切换到 FFmpeg 快速模式`, 'error')
}

function startProbe() {
  // 让窗口先完成首帧渲染，再占用 GPU 做探测
  setTimeout(() => {
    api.probeEngines().then(handleProbe).catch((error) => {
      console.warn('引擎探测失败', error)
    })
  }, 700)
}

/* ────────────────────── 事件 ────────────────────── */

function openSheet(id) {
  const dialog = el(id)
  if (!dialog || dialog.open) return
  if (id === 'settingsDialog') renderSettingsSheet()
  dialog.showModal()
}

function closeSheet(id) {
  const dialog = el(id)
  if (dialog?.open) dialog.close()
}

/** 点击遮罩区域关闭（dialog 本体铺满内容，只有遮罩处 target 才会是它自己） */
function bindSheetDismiss(id) {
  const dialog = el(id)
  if (!dialog) return
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect()
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    if (!inside) dialog.close()
  })
}

function renderSettingsSheet() {
  renderFormat()
  renderQuality()
  renderOutputMode()
  renderNoise()
  renderUiScale()
  renderEnv()
  el('formatField').hidden = currentMode() !== 'image'
  el('qualityField').hidden = currentMode() !== 'video'
  el('noiseField').hidden = state.settings.engine !== 'cugan'
}

function renderUiScale() {
  const host = el('uiScaleChips')
  if (!host) return
  const current = Number(state.settings.uiScale) || DEFAULT_UI_SCALE

  host.innerHTML = UI_SCALES.map(
    (value) =>
      `<button type="button" class="seg__btn${Math.abs(value - current) < 0.011 ? ' is-active' : ''}" data-ui-scale="${value}">${Math.round(value * 100)}%</button>`
  ).join('')

  host.querySelectorAll('.seg__btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const value = Number(btn.dataset.uiScale)
      state.settings.uiScale = value
      await api.setUiScale(value)
      renderUiScale()
    })
  })
}

function stepUiScale(direction) {
  const current = Number(state.settings.uiScale) || DEFAULT_UI_SCALE
  const index = UI_SCALES.findIndex((value) => Math.abs(value - current) < 0.011)
  const base = index < 0 ? UI_SCALES.indexOf(DEFAULT_UI_SCALE) : index
  const next = Math.min(UI_SCALES.length - 1, Math.max(0, base + direction))
  applyUiScale(UI_SCALES[next])
}

async function applyUiScale(next) {
  const clamped = Math.min(1.4, Math.max(0.9, Math.round(next * 100) / 100))
  state.settings.uiScale = clamped
  await api.setUiScale(clamped)
  renderUiScale()
}

/** 运行环境列表：把探测结果摊开说清楚，而不是一个灰色小点 */
function renderEnv() {
  const items = []

  const esrganStatus = engineStatus('esrgan')
  const probe = state.probe.esrgan
  if (!esrganStatus?.available) {
    items.push({ name: 'Real-ESRGAN', state: engineUnavailableReason('esrgan') || '未安装', cls: 'is-off' })
  } else if (probe?.ok === true) {
    items.push({
      name: 'Real-ESRGAN',
      state: probe.slow ? `可用 · 较慢（${probe.elapsed}ms）` : `可用 · ${probe.elapsed}ms`,
      cls: probe.slow ? 'is-warn' : 'is-on'
    })
  } else if (probe?.ok === false) {
    items.push({ name: 'Real-ESRGAN', state: probe.reason || '不可用', cls: 'is-off' })
  } else {
    items.push({ name: 'Real-ESRGAN', state: '检测中…', cls: '' })
  }

  const cugan = engineStatus('cugan')
  items.push({
    name: 'Real-CUGAN',
    state: cugan?.available ? '可用' : '未安装（可选）',
    cls: cugan?.available ? 'is-on' : 'is-off'
  })

  const ffmpeg = engineStatus('ffmpeg')
  items.push({
    name: 'FFmpeg',
    state: ffmpeg?.available ? (ffmpeg.hardwareEncode ? '可用 · NVENC' : '可用 · CPU') : '缺失',
    cls: ffmpeg?.available ? 'is-on' : 'is-off'
  })

  el('envList').innerHTML = items
    .map(
      (item) =>
        `<div class="env__item ${item.cls}"><span class="env__dot"></span><span class="env__name">${item.name}</span><span class="env__state">${escapeHtml(item.state)}</span></div>`
    )
    .join('')
}

async function openTaskDetail(id) {
  const task = state.tasks.find((item) => item.id === id)
  if (!task) return

  el('taskTitle').textContent = task.name

  const params =
    task.engine === 'ffmpeg' ? `${task.scale}x` : `${task.model || '—'} · ${task.scale}x`
  const rows = [
    ['状态', statusText(task)],
    ['引擎', ENGINE_LABEL[task.engine] || task.engine || '—'],
    ['参数', params],
    ['源尺寸', task.width ? `${task.width}×${task.height}` : '—'],
    ['输出尺寸', task.outWidth ? `${task.outWidth}×${task.outHeight}` : '—'],
    ['输入路径', task.input],
    ['输出路径', task.output || '—'],
    ['耗时', task.elapsedMs ? fmtDuration(task.elapsedMs) : '—']
  ]

  el('taskFacts').innerHTML = rows
    .map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join('')

  const hints = []
  if (task.error) hints.push(task.error)
  if (task.warning) hints.push(`注意：${task.warning}`)
  el('taskHint').textContent = hints.join('；')

  el('taskLog').textContent = '加载中…'
  openSheet('taskDialog')

  const logs = await api.taskLogs(id)
  const logEl = el('taskLog')
  logEl.textContent = logs.length ? logs.join('\n') : ''
  logEl.scrollTop = logEl.scrollHeight
}

async function pickFilesForMode() {
  const mode = currentMode()
  const files = await api.pickFiles(mode)
  if (files.length) addFiles(files)
}

function bindEvents() {
  el('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    state.settings.theme = dark ? 'light' : 'dark'
    applyTheme(true)
    persist()
  })

  el('modeSwitch').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mode]')
    if (!btn) return
    state.settings.mode = btn.dataset.mode
    renderModeSwitch()
    renderEngines()
    renderModels()
    renderNoise()
    renderQueueControls()
    persist()
  })

  el('engineSelect').addEventListener('change', (event) => {
    state.settings.engine = event.target.value
    renderEngines()
    renderModels()
    persist()
  })

  el('modelSelect').addEventListener('change', (event) => {
    state.settings.model = event.target.value
    renderModels()
    persist()
  })

  el('outputModeChips').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-output]')
    if (!btn) return
    state.settings.outputMode = btn.dataset.output
    if (btn.dataset.output === 'folder' && !state.settings.outputDir) {
      pickOutputDir()
      return
    }
    renderOutputMode()
    persist()
  })

  el('pickDirBtn').addEventListener('click', pickOutputDir)

  el('reprobeBtn').addEventListener('click', async () => {
    const label = el('reprobeLabel')
    const icon = el('reprobeBtn').querySelector('.probe-icon')
    if (label.dataset.busy === '1') return
    label.dataset.busy = '1'
    label.textContent = '检测中…'
    icon.classList.add('is-spinning')
    try {
      handleProbe(await api.probeEngines({ force: true }))
    } catch (error) {
      toast(`检测失败：${error.message}`, 'error')
    } finally {
      label.dataset.busy = '0'
      label.textContent = '重新检测 AI 引擎'
      icon.classList.remove('is-spinning')
    }
  })

  el('pickImageBtn').addEventListener('click', async () => {
    const files = await api.pickFiles('image')
    if (files.length) addFiles(files)
  })

  el('pickVideoBtn').addEventListener('click', async () => {
    const files = await api.pickFiles('video')
    if (files.length) addFiles(files)
  })

  el('runBtn').addEventListener('click', async () => {
    el('runBtn').disabled = true
    await api.start()
  })

  el('clearBtn').addEventListener('click', () => api.clearFinished())

  el('moreBtn').addEventListener('click', () => openSheet('settingsDialog'))

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => closeSheet(btn.dataset.close))
  }
  bindSheetDismiss('settingsDialog')
  bindSheetDismiss('taskDialog')

  window.addEventListener('keydown', (event) => {
    // 模态窗口打开时，ESC 与快捷键交给浏览器原生逻辑
    if (document.querySelector('dialog[open]')) return

    if (event.key === 'Escape') {
      if (state.selectedId) {
        state.selectedId = null
        renderTasks()
        renderPreview(true)
      }
      return
    }

    const mod = event.ctrlKey || event.metaKey
    if (!mod) return

    if (event.key === 'o' || event.key === 'O') {
      event.preventDefault()
      pickFilesForMode()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (!el('runBtn').disabled) el('runBtn').click()
      return
    }

    // Ctrl + / - / 0 调整界面比例
    if (event.key === '=' || event.key === '+') {
      event.preventDefault()
      stepUiScale(1)
      return
    }
    if (event.key === '-') {
      event.preventDefault()
      stepUiScale(-1)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      applyUiScale(DEFAULT_UI_SCALE)
    }
  })

  // 拖拽
  let dragDepth = 0
  const dropzone = el('dropzone')

  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    dragDepth += 1
    dropzone.classList.add('is-over')
  })

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) dropzone.classList.remove('is-over')
  })

  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
  })

  window.addEventListener('drop', () => {
    dragDepth = 0
    dropzone.classList.remove('is-over')
  })

  api.onDrop((paths) => addFiles(paths))

  api.onQueueUpdate((tasks) => {
    const before = new Map(state.tasks.map((task) => [task.id, task.status]))
    const grew = tasks.length !== state.tasks.length
    state.tasks = tasks

    if (grew) {
      const body = el('queueBody')
      requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight
      })
    }

    renderTasks()
    renderPreview()

    // 刚跑完的任务闪一下，让用户注意到结果
    for (const task of tasks) {
      if (before.get(task.id) === 'running' && task.status === 'done') flashDone(task.id)
    }
  })

  api.onLog((entry) => console.log(`[${entry.id}] ${entry.line}`))

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((state.settings.theme || 'system') === 'system') applyTheme()
  })
}

async function pickOutputDir() {
  const dir = await api.pickOutputDir()
  if (!dir) {
    if (!state.settings.outputDir) {
      state.settings.outputMode = 'suffix'
      renderOutputMode()
    }
    return
  }
  state.settings.outputDir = dir
  state.settings.outputMode = 'folder'
  renderOutputMode()
  persist()
}

async function init() {
  state.info = await api.info()
  state.settings = { ...state.info.settings }
  document.title = 'Omni Upscale'

  applyTheme()
  renderStatus()
  renderModeSwitch()
  renderEngines()
  renderModels()
  renderNoise()
  renderLongEdge()
  renderFormat()
  renderQuality()
  renderOutputMode()
  initTooltips()
  bindEvents()

  state.tasks = await api.listTasks()
  renderTasks()

  const missing = []
  if (!engineStatus('esrgan')?.available) missing.push('Real-ESRGAN')
  if (!engineStatus('ffmpeg')?.available) missing.push('FFmpeg')
  if (missing.length) toast(`运行时不完整：缺少 ${missing.join('、')}`, 'error')

  startProbe()
}

init().catch((error) => {
  window.__omniErrors.push(String(error?.stack || error))
  console.error(error)
  toast(`初始化失败：${error.message}`, 'error')
})
