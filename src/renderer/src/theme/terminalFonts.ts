import regularUrl from '../assets/fonts/SauceCodeProNerdFontMono-Regular.ttf?url'
import mediumUrl from '../assets/fonts/SauceCodeProNerdFontMono-Medium.ttf?url'
import boldUrl from '../assets/fonts/SauceCodeProNerdFontMono-Bold.ttf?url'

/**
 * 内嵌终端字体：Sauce Code Pro Nerd Font Mono（Source Code Pro + Nerd Font 图标，OFL）。
 * 用 ?url 让 Vite 在开发和打包下都生成正确路径，注入 @font-face。
 */
export function registerTerminalFonts(): void {
  const style = document.createElement('style')
  style.textContent = `
@font-face {
  font-family: 'SauceCodePro Nerd Font Mono';
  src: url('${regularUrl}') format('truetype');
  font-weight: 400;
}
@font-face {
  font-family: 'SauceCodePro Nerd Font Mono';
  src: url('${mediumUrl}') format('truetype');
  font-weight: 500;
}
@font-face {
  font-family: 'SauceCodePro Nerd Font Mono';
  src: url('${boldUrl}') format('truetype');
  font-weight: 700;
}
`
  document.head.appendChild(style)
}
