import { BrowserWindow, nativeTheme, type WebContents } from 'electron'

/**
 * 系统标题栏按钮的明暗跟着当前主题走（themeSource 固定为 dark/light，不再跟随系统）。
 * 返回该主题是不是深色，给窗口底色用。
 */
export function followAppTheme(dark: boolean): boolean {
  nativeTheme.themeSource = dark ? 'dark' : 'light'
  return dark
}

/** 窗口还没显示时改背景色，Windows 会把第一帧停在白屏。 */
export function paintWindowChrome(win: BrowserWindow, background: string): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return
  win.setBackgroundColor(background)
}

export function paintFromContents(contents: WebContents, dark: boolean, background: string): void {
  nativeTheme.themeSource = dark ? 'dark' : 'light'
  const win = BrowserWindow.fromWebContents(contents)
  if (win) paintWindowChrome(win, background)
}
