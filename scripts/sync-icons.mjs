// material-icon-theme 的 1251 个 SVG 同步成静态资源（frontend/public/icons）。
// 图标按 URL 直接引用，不走 JS module：eager glob 会给每个 SVG 生成一条模块请求，
// 整页刷新瞬间 vite 还在重转换，这批请求落空（返回 index.html）就会白屏。
// npm run dev / build 前由 pre* 钩子自动执行；根目录 scripts/prebuild.mjs 也会调。
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'frontend', 'node_modules', 'material-icon-theme', 'icons')
const dest = join(root, 'frontend', 'public', 'icons')

if (!existsSync(src)) {
  console.error(`图标源不存在，先跑 frontend 的 npm install: ${src}`)
  process.exit(1)
}
if (existsSync(dest) && readdirSync(dest).length === readdirSync(src).length) {
  console.log('icons 已同步')
} else {
  cpSync(src, dest, { recursive: true })
  console.log(`icons 已同步到 ${dest}（${readdirSync(dest).length} 个）`)
}
