# 第三方组件与授权

本项目自身代码采用 [MIT License](LICENSE)，允许商业使用。下列第三方资源**均为可商用授权**，但各自的条件不同：

| 组件 | 授权 | 可商用 | 分发时的义务 |
| --- | --- | --- | --- |
| Real-ESRGAN（运行时 + 模型） | BSD-3-Clause | ✅ | 保留版权与免责声明 |
| Real-CUGAN（可选） | MIT | ✅ | 保留版权声明 |
| FFmpeg（随包构建） | GPL v3 | ✅ | 需提供对应源码获取方式 |
| Noto Sans SC | SIL OFL 1.1 | ✅ | 保留许可、不得单独售卖字体 |
| Lucide | ISC | ✅ | 保留版权声明 |
| Plyr | MIT | ✅ | 保留版权声明 |
| Floating UI | MIT | ✅ | 保留版权声明 |

> 项目自身代码是 MIT；上面这些是它依赖的第三方部分，**不改变本项目代码的授权**。

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

- 授权：GPL v3（所附构建）
- 站点：https://ffmpeg.org
- 用法：`resources/ffmpeg/ffmpeg.exe` 原样分发，通过 `child_process` 调用，未修改源码、未做动态链接。

### 分发时的 GPL 义务

只在进程边界调用 FFmpeg，本项目代码不需要开源。但**对外分发安装包**（含企业内部分发）时，需要随附该 FFmpeg 构建的源码获取方式：

- 官方源码：https://ffmpeg.org/download.html
- 所用构建的来源：https://www.gyan.dev/ffmpeg/builds/（essentials 构建）

仅自己使用、不对外分发时不触发该条款。

### 想避开 GPL？

换成 LGPL 构建即可，但要知道代价：**LGPL 版不含 libx264**，而本项目的软件编码路径依赖它。换掉之后只有带 NVENC / QSV / AMF 硬件编码器的机器能输出视频，纯 CPU 环境会直接失败。实际项目中保留 GPL 版 + 附源码链接通常更稳妥。
