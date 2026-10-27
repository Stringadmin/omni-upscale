'use strict'

const path = require('node:path')

/**
 * Omni Upscale 打包配置。
 *
 * 运行时（realesrgan 可执行文件 + 模型 + ffmpeg）通过 extraResources 放到
 * app.asar 之外，这样用户可以直接替换模型文件而无需重新打包，也避免
 * 大体积二进制被打进 asar 导致启动缓慢。
 */
module.exports = {
  appId: 'com.omniai.upscale',
  productName: 'Omni Upscale',
  copyright: 'Copyright © 2026 OmniAI',
  artifactName: 'OmniUpscale-Setup-${version}.${ext}',
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'src/**/*',
    'package.json',
    '!**/*.map',
    '!**/*.test.js'
  ],
  extraResources: [
    // 授权文件随包分发，满足 MIT / BSD / GPL 的声明保留要求
    {
      from: 'LICENSE',
      to: 'LICENSE.txt',
      filter: ['**/*']
    },
    {
      from: 'THIRD-PARTY-NOTICES.md',
      to: 'THIRD-PARTY-NOTICES.md',
      filter: ['**/*']
    },
    {
      from: 'resources/realesrgan',
      to: 'realesrgan',
      filter: ['**/*']
    },
    {
      from: 'resources/ffmpeg',
      to: 'ffmpeg',
      filter: ['**/*']
    }
  ],
  asar: true,
  asarUnpack: [],
  win: {
    icon: path.join(__dirname, 'build', 'icon.ico'),
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Omni Upscale',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true
  }
}
