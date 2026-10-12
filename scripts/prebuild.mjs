import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// wails build 前的准备：
// 1. 编译配套 CLI 到嵌入资源目录（internal/app/cliembed_*.go 用 go:embed 打进主程序）；
// 2. 同步应用图标 resources/icon.png → build/appicon.png（Wails 约定位置，
//    build/ 整个是忽略目录），并删掉已生成的 icon.ico 强制重建。
// 可选参数：目标平台（GOOS）。不传则编译当前宿主平台。
// 用法：node scripts/prebuild.mjs [darwin|linux|windows]，然后 wails build。
const goos = process.argv[2] ?? { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
if (!['darwin', 'linux', 'windows'].includes(goos)) {
  console.error(`用法: node scripts/prebuild.mjs [darwin|linux|windows]，收到: ${goos}`)
  process.exit(1)
}

const name = goos === 'windows' ? 'termpilot.exe' : 'termpilot'
// go build 的 -o 相对路径按子进程 cwd 解析，这里用绝对路径。
const outDir = resolve('internal', 'app', 'resources', 'cli')
mkdirSync(outDir, { recursive: true })
execFileSync('go', ['build', '-ldflags', '-s -w', '-o', join(outDir, name), '.'], {
  cwd: join('cmd', 'termpilot-cli'),
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, CGO_ENABLED: '0' }
})

mkdirSync('build', { recursive: true })
copyFileSync(join('resources', 'icon.png'), join('build', 'appicon.png'))
rmSync(join('build', 'windows', 'icon.ico'), { force: true })
