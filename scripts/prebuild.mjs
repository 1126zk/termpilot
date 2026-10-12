import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 把 CLI 编进嵌入资源目录（internal/app/cliembed_*.go 用 go:embed 打进主程序）。
// 可选参数：目标平台（GOOS）。不传则编译当前宿主平台。
// 用法：node scripts/build-cli.mjs [darwin|linux|windows]，然后 wails build。
const goos = process.argv[2] ?? { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
if (!['darwin', 'linux', 'windows'].includes(goos)) {
  console.error(`用法: node scripts/build-cli.mjs [darwin|linux|windows]，收到: ${goos}`)
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
