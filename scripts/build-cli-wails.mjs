import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 把 CLI 编进 wailsapp 的嵌入资源目录（wailsapp/sysops.go 用 go:embed 打进主程序）。
// 可选参数：目标平台（GOOS）。不传则编译当前宿主平台。
// 用法：node scripts/build-cli-wails.mjs [darwin|linux|windows]，然后 wails build。
const goos = process.argv[2] ?? { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
if (!['darwin', 'linux', 'windows'].includes(goos)) {
  console.error(`用法: node scripts/build-cli-wails.mjs [darwin|linux|windows]，收到: ${goos}`)
  process.exit(1)
}
const name = goos === 'windows' ? 'termpilot.exe' : 'termpilot'
const outDir = join('wailsapp', 'resources', 'cli')
mkdirSync(outDir, { recursive: true })
execFileSync('go', ['build', '-ldflags', '-s -w', '-o', join(outDir, name), '.'], {
  cwd: join('cli'),
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, CGO_ENABLED: '0' }
})
