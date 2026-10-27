# Omni Upscale

[![Latest release](https://img.shields.io/github/v/release/Stringadmin/omni-upscale)](https://github.com/Stringadmin/omni-upscale/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](#)

从 OmniAI 漫画工作台里抽出来的**独立超分工具**，只做一件事：把图片和视频放大、补细节。

不带项目库、素材库、聊天、账号体系——启动即用，全程离线。

## 功能

**图片**
- Real-ESRGAN：4 个模型（动画 / 插画 / 写实 / 保守），2x / 3x / 4x
- Real-CUGAN：可选引擎，5 档降噪，适合压缩严重的二次元素材
- 输出 PNG / JPG / WebP
- **透明通道自动保留**：含 alpha 的素材会拆成「RGB 走 AI + alpha 走 lanczos」，最后合并回去（直接丢给 ncnn 会把透明区变黑或整张变全透明）
- 原图与结果左右对比，拖动分割线查看细节差异

**视频**
- FFmpeg 快速缩放：纯重采样，秒级完成，目标 1080p / 1440p / 2160p / 4320p
- Real-ESRGAN / Real-CUGAN 逐帧超分：抽帧 → AI 增强 → 重新编码，保留原音轨
- **分段处理**：按分辨率自动切段（每段≤300MB 临时空间），段内跑完立刻清理，再拼接混音
- **分段处理**：按分辨率自动切段（每段≤300MB 临时空间），段内跑完立刻清理，再拼接混音
- 自动探测 NVENC 硬件编码，重编码阶段比纯 CPU 快数倍

**通用**
- 批量队列，拖入多个文件一次处理
- 真实进度（解析引擎输出的百分比，不是假动画）
- 可随时取消，中断后自动清理临时文件
- 输出永远是**新文件**，不覆盖原素材
- 暗 / 亮双主题，默认跟随系统
- 快捷键：`Ctrl+O` 选择文件、`Ctrl+Enter` 开始、`Ctrl + +/-/0` 调整界面比例、`Esc` 返回

## 界面

极简单页布局：顶部状态条 + 中间预览 + 底部 dock + 底部队列。主界面只露引擎、模型、倍率，其余收进设置窗口。

**两个模态窗口**（原生 `<dialog>`，支持 ESC 与点击遮罩关闭）：

- **设置**（右下齿轮）：输出格式 / 视频质量 / 保存位置 / 降噪 / 界面显示比例 / 运行环境状态，附「重新检测 AI 引擎」
- **任务详情**（任务行 ⓘ）：状态、引擎参数、源与输出尺寸、完整路径、耗时，以及带时间戳的运行日志

**界面比例**默认 112%，可在设置里切 90% / 100% / 112% / 125% / 140%，或用 `Ctrl + 加号 / 减号` 实时调整，选择会持久化。

- **字体**：内嵌 Noto Sans SC 可变字重子集（`src/renderer/fonts/omni-sans.woff2`），不依赖系统装了什么中文字体。
- **图标**：[Lucide](https://lucide.dev)（ISC），构建期抽取所需图标生成内联 sprite。
- **定位**：[Floating UI](https://floating-ui.com)（MIT），负责 Tooltip 的边界翻转。
- **播放器**：[Plyr](https://plyr.io)（MIT），替换原生 `<video controls>`：自带进度拖拽、倍速、画中画、全屏，配色跟随主题。图标已内联，不走 CDN。
- **自适应**：dock 控件在 1180 / 1024 两档宽度自动收紧，矮窗口收缩队列高度，1600+ 大屏放宽留白。最小可用窗口 960×640。

授权明细见 `THIRD-PARTY-NOTICES.md`。

## 下载

到 [Releases](https://github.com/Stringadmin/omni-upscale/releases/latest) 按需要挑一个：

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `OmniUpscale-Setup-1.0.0.exe` | 170 MB | 安装版，可选安装目录，带卸载与开始菜单项 |
| `OmniUpscale-1.0.0-win-x64-portable.zip` | 210 MB | 绿色版，解压后直接跑 `Omni Upscale.exe`，不写注册表 |
| `omni-upscale-runtime.zip` | 63 MB | 只有运行时（ffmpeg + 4 个模型），给源码构建用 |

前两个都已内置运行时，下载即用。

## 运行

```bash
git clone https://github.com/Stringadmin/omni-upscale.git
cd omni-upscale
npm install
npm start
```

首次运行前需要先准备运行时（ffmpeg + 模型），在 PowerShell 里执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1
```

脚本会优先从本项目的 Release 拉 `omni-upscale-runtime.zip`（国内比 gyan.dev 稳），失败再回退官方源。网络慢就加代理：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1 -Proxy http://127.0.0.1:65533
```

## 打包 Windows 安装包

```bash
npm run package:win
```

产物在 `release/OmniUpscale-Setup-1.0.0.exe`。

## 目录结构

```
src/
  main/
    index.js            窗口与生命周期
    ipc.js              IPC 注册
    tasks.js            任务队列与视频管线编排
    procs.js            子进程执行、进度解析、进程树终止
    paths.js            运行时资源定位
    settings.js         参数持久化
    engines/
      esrgan.js         Real-ESRGAN 封装
      cugan.js          Real-CUGAN 封装（可选）
      ffmpeg.js         探测 / 抽帧 / 编码 / 快速缩放
  preload/index.js      contextBridge 桥接、启动前落定主题
  renderer/
    index.html          单页结构 + 内联 SVG sprite
    styles.css          双主题变量 + 动效层
    app.js              渲染逻辑（原生 ESM，无框架）
    vendor/             Floating UI 的 ESM 构建
    fonts/              Noto Sans SC 子集
  scripts/
    build-icons.mjs     从 lucide-static 生成图标 sprite
    apply-sprite.mjs    把 sprite 注入 index.html
    make-icon.py        生成应用图标
resources/
  realesrgan/           可执行文件 + models（约 51 MB）
  ffmpeg/ffmpeg.exe     约 62 MB
```

## 模型与运行时

仓库**不包含**二进制文件，全部从官方渠道获取。执行 `scripts/fetch-runtime.ps1` 会自动下载前两项。

### Real-ESRGAN —— BSD-3-Clause

- 项目主页：https://github.com/xinntao/Real-ESRGAN
- 运行时 + 模型（Windows 包）：https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0
- 论文：https://arxiv.org/abs/2107.10833

包内 4 个模型：

| 模型文件 | 适用素材 | 支持倍率 |
| --- | --- | --- |
| `realesr-animevideov3-x2 / x3 / x4` | 动漫、3D 动画 | 2x / 3x / 4x |
| `realesrgan-x4plus-anime` | 静帧插画、漫画线稿 | 4x |
| `realesrgan-x4plus` | 实拍、半写实 | 4x |
| `realesrnet-x4plus` | 保守处理、少伪影 | 4x |

**替换模型**：把 `.bin` / `.param` 丢进 `resources/realesrgan/models/`，文件名与上表一致即可被识别。安装后对应 `<安装目录>/resources/realesrgan/models/`，不需要重新打包。

### Real-CUGAN —— MIT（可选引擎）

- 项目主页：https://github.com/nihui/realcugan-ncnn-vulkan
- 发布页（含 models-se / models-pro）：https://github.com/nihui/realcugan-ncnn-vulkan/releases

放到这样的结构，界面会自动点亮：

```
resources/realcugan/
  realcugan-ncnn-vulkan.exe
  models-se/
    *.bin
    *.param
```

### FFmpeg —— GPL

- 官网：https://ffmpeg.org
- Windows 构建：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases

### 字体与前端依赖

- Noto Sans SC（SIL OFL 1.1）：https://fonts.google.com/noto/specimen/Noto+Sans+SC
- Lucide（ISC）：https://lucide.dev
- Plyr（MIT）：https://plyr.io
- Floating UI（MIT）：https://floating-ui.com

## 关于显卡

AI 超分走 Real-ESRGAN 的 ncnn-vulkan 后端，**必须要有可用的 Vulkan 设备，没有 CPU 回退**。所以：

| 机器情况 | AI 超分 | FFmpeg 快速 | 实际表现 |
| --- | --- | --- | --- |
| 独显（NVIDIA / AMD / Intel Arc） | ✅ | ✅ | 1080p 图 2x 约 1-3 秒 |
| 近年核显（UHD / Iris Xe） | ✅ | ✅ | 1080p 图 2x 约 5-20 秒 |
| 老核显（HD 4000 及更早、部分远程桌面） | ❌ | ✅ | AI 引擎自动置灰，退回重采样 |
| 虚拟机 / 服务器 / 无显卡 | ❌ | ✅ | 同上，只保留纯 CPU 路径 |

启动后会在后台真跑一次 16×16 的样例做探测，不是看文件在不在：

- 探测失败 → AI 引擎在下拉里置灰，自动切到 **FFmpeg 快速**，并说明原因
- 探测超过 8 秒 → 判定为软件渲染，仍可用但会提示优先用快速模式
- 装了驱动想重测 → 右下角设置弹层 →「重新检测 AI 引擎」

**质量差异**：FFmpeg 快速模式是 lanczos 重采样 + 轻锐化，放大后不会生成新细节，只保证边缘干净；Real-ESRGAN 是模型推理，能补纹理和线条。没 GPU 时前者就是可用的下限。

## 已知限制

**临时磁盘**：视频 AI 超分是「抽帧 → 逐帧超分 → 重编码」，中间会产生两份 PNG 序列。已改为分段处理，峰值临时空间稳定在 **约 250-300 MB**（与视频长度无关）。实测 30 秒 720p 2x：峰值 235 MB。

**位深**：逐帧 AI 只处理 8bit RGB，10bit / 12bit 源会输出为 8bit（任务完成时会在队列里标黄提示）。HDR（PQ / HLG）素材按 SDR 处理，颜色会有偏差，目前不做 tonemap。

**分段不影响画质**：每段用完全相同的模型与编码参数，拼接时 `-c copy` 不重新编码。实测 720 帧源视频 → 输出 720 帧，时长 30.00s、24fps、音轨完整。

**分段不影响画质**：每段用完全相同的模型与编码参数，拼接时 `-c copy` 不重新编码。实测 720 帧源视频 → 输出 720 帧，时长 30.00s、24fps、音轨完整。

**耗时**：与帧数成正比。10 秒 1080p 约 240 帧，视显卡不同需要几分钟到几十分钟。

**平台**：仅提供 Windows x64 构建（`resources/` 里只有 Windows 二进制）。

## 许可证

本项目代码采用 **[MIT License](LICENSE)**，**允许商业使用**、修改、分发与私有化部署，只需在副本中保留版权与许可声明。

| 组成 | 授权 | 可商用 | 备注 |
| --- | --- | --- | --- |
| 本项目代码 | MIT | ✅ | 无附加限制 |
| Real-ESRGAN 运行时与模型 | BSD-3-Clause | ✅ | 保留版权声明即可 |
| Real-CUGAN | MIT | ✅ | 可选组件 |
| FFmpeg（随包构建） | GPL v3 | ✅ | 分发时需履行 GPL 义务 |
| Noto Sans SC | SIL OFL 1.1 | ✅ | 可嵌入、可再分发 |
| Lucide / Plyr / Floating UI | ISC / MIT / MIT | ✅ | 前端依赖 |

### 关于 FFmpeg 的 GPL

随安装包分发的是 **GPL 构建**的 `ffmpeg.exe`。本项目只以子进程方式调用，未修改、未链接其源码，属于独立程序的聚合分发——你的代码不必开源。

但**对外分发安装包时**需要履行 GPL 义务：提供该 FFmpeg 构建的源码获取方式（https://ffmpeg.org/download.html）。自己内部使用不触发分发条款。

想完全避开 GPL，可以换成 LGPL 构建，但要注意代价：**LGPL 版不含 `libx264`**，而本项目的软件编码依赖它。换掉之后只有具备 NVENC / QSV / AMF 硬件编码器的机器才能输出视频，纯 CPU 环境会失败。多数情况下保留 GPL 版 + 附上源码链接是更实际的选择。
