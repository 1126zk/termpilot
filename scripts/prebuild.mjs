import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// wails build 前的准备：
// 1. 编译配套 CLI 到嵌入资源目录（internal/app/cliembed_*.go 用 go:embed 打进主程序）；
// 2. 同步应用图标 resources/icon.png → build/appicon.png（Wails 约定位置，
//    build/ 整个是忽略目录），并删掉已生成的 icon.ico 强制重建；
// 3. Windows 上下载官方 ConPTY（conpty.dll + OpenConsole.exe），
//    internal/terminal 用 go:embed 打进主程序。版本要和 bundledConptyVersion 一致。
// 可选参数：目标平台（GOOS）。不传则编译当前宿主平台。
// 用法：node scripts/prebuild.mjs [darwin|linux|windows]，然后 wails build。

// 和 internal/terminal/conpty_setup_windows.go 的 bundledConptyVersion 保持一致。
const CONPTY_VERSION = '1.25.260930003'

const goos = process.argv[2] ?? { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
if (!['darwin', 'linux', 'windows'].includes(goos)) {
  console.error(`用法: node scripts/prebuild.mjs [darwin|linux|windows]，收到: ${goos}`)
  process.exit(1)
}

// x64 和 arm64 都放下，换 GOARCH 构建时不用再下载。
const CONPTY_ARCHES = [
  ['win-x64', 'x64'],
  ['win-arm64', 'arm64']
]

async function fetchConpty() {
  if (goos !== 'windows') return
  const root = resolve('internal', 'terminal', 'resources', 'conpty')
  const stamp = join(root, 'VERSION')
  const ready = CONPTY_ARCHES.every(
    ([runtime]) => existsSync(join(root, runtime, 'conpty.dll')) && existsSync(join(root, runtime, 'OpenConsole.exe'))
  )
  if (ready && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === CONPTY_VERSION) {
    console.log(`ConPTY ${CONPTY_VERSION} 已在`)
    return
  }
  const url = `https://www.nuget.org/api/v2/package/Microsoft.Windows.Console.ConPTY/${CONPTY_VERSION}`
  const work = join(tmpdir(), `termpilot-conpty-${CONPTY_VERSION}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`下载 ConPTY 失败: ${response.status} ${url}`)
  }
  const pkg = join(work, 'pkg.zip')
  writeFileSync(pkg, Buffer.from(await response.arrayBuffer()))
  execFileSync('tar', ['-xf', pkg, '-C', work], { stdio: 'inherit' })
  for (const [runtime, native] of CONPTY_ARCHES) {
    const dest = join(root, runtime)
    mkdirSync(dest, { recursive: true })
    copyFileSync(join(work, 'runtimes', runtime, 'native', 'conpty.dll'), join(dest, 'conpty.dll'))
    copyFileSync(join(work, 'build', 'native', 'runtimes', native, 'OpenConsole.exe'), join(dest, 'OpenConsole.exe'))
  }
  writeFileSync(stamp, `${CONPTY_VERSION}\n`)
  rmSync(work, { recursive: true, force: true })
  console.log(`ConPTY ${CONPTY_VERSION} 已放入 ${root}`)
}

await fetchConpty()

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
