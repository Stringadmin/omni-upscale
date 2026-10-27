# 第三方组件与授权

本项目的界面与运行时依赖以下开源资源，均为可商用授权。

## 图标 — Lucide

- 授权：ISC License（见 `THIRD-PARTY-lucide.txt`）
- 站点：https://lucide.dev
- 用法：构建期由 `scripts/build-icons.mjs` 从 `lucide-static` 抽取所需图标生成内联 SVG sprite（`src/renderer/sprite.html`），运行时不带任何依赖。

## 定位引擎 — Floating UI

- 授权：MIT License（见 `THIRD-PARTY-floating-ui.txt`）
- 站点：https://floating-ui.com
- 用法：`src/renderer/vendor/` 下为 `@floating-ui/dom` + `core` + `utils` 的 ESM 构建，仅改写了内部裸模块路径，逻辑未改动。
- 用途：Tooltip 的定位与边界翻转（`flip` / `shift` / `offset`）。

## 播放器 — Plyr

- 授权：MIT License（见 `THIRD-PARTY-plyr.txt`）
- 站点：https://plyr.io
- 用法：`src/renderer/vendor/plyr.mjs` + `plyr.css`。Plyr 3.8 的图标默认从 CDN 拉取，离线环境会空白，因此把 `plyr.svg` 的 17 个 symbol 内联进 `index.html`（`scripts/inject-plyr-icons.mjs`），并在初始化时设置 `iconUrl: ''`。

## 字体 — Noto Sans SC

- 授权：SIL Open Font License 1.1
- 站点：https://fonts.google.com/noto/specimen/Noto+Sans+SC
- 用法：由系统安装的 `NotoSansSC-VF.ttf`（Variable Font，100–900 字重）子集化为 `src/renderer/fonts/omni-sans.woff2`，保留拉丁、常用标点与 CJK 统一表意文字区（U+4E00–U+9FFF）。

## 超分引擎 — Real-ESRGAN

- 授权：BSD-3-Clause（见 `resources/realesrgan/LICENSE`）
- 站点：https://github.com/xinntao/Real-ESRGAN
- 用法：`resources/realesrgan/` 内的 ncnn-vulkan 可执行文件与模型，原样分发。

## 视频处理 — FFmpeg

- 授权：GPL（所附构建）
- 站点：https://ffmpeg.org
- 用法：`resources/ffmpeg/ffmpeg.exe` 原样分发，通过子进程调用。
