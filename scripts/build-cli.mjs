import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 可选参数：目标平台（GOOS）。不传则编译当前宿主平台。
// CLI 是纯标准库零依赖，CGO_ENABLED=0 后交叉编译零成本，打 mac/linux 包时在 Windows 上也能出对应二进制。
const goos = process.argv[2] ?? { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
if (!['darwin', 'linux', 'windows'].includes(goos)) {
  console.error(`用法: node scripts/build-cli.mjs [darwin|linux|windows]，收到: ${goos}`)
  process.exit(1)
}
const name = goos === 'windows' ? 'termpilot.exe' : 'termpilot'
mkdirSync(join('cli', 'dist'), { recursive: true })
execFileSync('go', ['build', '-ldflags', '-s -w', '-o', join('dist', name), '.'], {
  cwd: join('cli'),
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, CGO_ENABLED: '0' }
})
