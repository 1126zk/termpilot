import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { dialog } from 'electron'
import { assertEditSize, assertTextBuffer, compareRemoteFiles } from '../../shared/file-listing'
import type { RemoteFile } from '../../shared/types'

/** 本地文件浏览。IPC 边界统一用正斜杠路径（Windows 形如 C:/Users/...），进主进程先转 native。 */
export class LocalFsService {
  /** '.' 或空 → 用户主目录；接受反斜杠输入；输出 native 绝对路径 */
  toNative(p: string): string {
    const raw = !p || p === '.' ? homedir() : p
    return resolve(sep === '\\' ? raw.replace(/\//g, '\\') : raw)
  }

  toPosix(p: string): string {
    return p.replace(/\\/g, '/')
  }

  async list(dir: string): Promise<{ path: string; entries: RemoteFile[] }> {
    const target = this.toNative(dir)
    const dirents = await readdir(target, { withFileTypes: true })
    const entries: RemoteFile[] = []
    for (const item of dirents) {
      const full = join(target, item.name)
      const kind: RemoteFile['kind'] = item.isDirectory() ? 'dir' : item.isSymbolicLink() ? 'link' : 'file'
      let size = 0
      let mtime = 0
      try {
        const stats = await lstat(full)
        size = stats.size
        mtime = stats.mtimeMs
      } catch {
        /* 没权限的条目保留名字，大小时间按 0 */
      }
      entries.push({ name: item.name, path: this.toPosix(full), kind, size, mtime })
    }
    entries.sort(compareRemoteFiles)
    return { path: this.toPosix(target), entries }
  }

  async mkdir(dir: string, name: string): Promise<void> {
    await mkdir(join(this.toNative(dir), name))
  }

  async remove(path: string, kind: RemoteFile['kind']): Promise<void> {
    const target = this.toNative(path)
    await rm(target, { recursive: kind === 'dir' })
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(this.toNative(from), this.toNative(to))
  }

  async readText(path: string): Promise<string> {
    const target = this.toNative(path)
    const stats = await lstat(target)
    assertEditSize(stats.size)
    const buf = await readFile(target)
    assertTextBuffer(buf)
    return buf.toString('utf8')
  }

  async writeText(path: string, text: string): Promise<void> {
    await writeFile(this.toNative(path), text, 'utf8')
  }

  async upload(dir: string): Promise<number> {
    const picked = await dialog.showOpenDialog({
      title: '上传到当前目录',
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return 0
    return this.uploadPaths(dir, picked.filePaths)
  }

  async uploadDir(dir: string): Promise<number> {
    const picked = await dialog.showOpenDialog({
      title: '上传文件夹到当前目录',
      properties: ['openDirectory', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return 0
    const target = this.toNative(dir)
    let done = 0
    for (const src of picked.filePaths) {
      await cp(src, join(target, basename(src)), { recursive: true })
      done += 1
    }
    return done
  }

  /** 拖入复制：把本地文件/目录按名字放进 dir，目录递归复制。 */
  async uploadPaths(dir: string, localPaths: string[]): Promise<number> {
    const target = this.toNative(dir)
    const items: { path: string; isDir: boolean }[] = []
    for (const local of localPaths) {
      try {
        const stats = await lstat(local)
        if (stats.isFile() || stats.isDirectory()) items.push({ path: local, isDir: stats.isDirectory() })
      } catch {
        /* 路径失效就跳过 */
      }
    }
    let done = 0
    for (const item of items) {
      if (item.isDir) {
        await cp(item.path, join(target, basename(item.path)), { recursive: true })
      } else {
        await copyFile(item.path, join(target, basename(item.path)))
      }
      done += 1
    }
    return done
  }

  /** 本地语义 = 另存副本 */
  async download(file: RemoteFile): Promise<boolean> {
    if (file.kind === 'dir') throw new Error('先进入目录再下载里面的文件')
    const picked = await dialog.showSaveDialog({
      title: '下载到本地',
      defaultPath: file.name
    })
    if (picked.canceled || !picked.filePath) return false
    await copyFile(this.toNative(file.path), picked.filePath)
    return true
  }

  /** 本地语义 = 另存副本 */
  async downloadDir(file: RemoteFile): Promise<boolean> {
    if (file.kind !== 'dir') throw new Error('只能下载目录')
    const picked = await dialog.showOpenDialog({
      title: '下载文件夹到',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return false
    await cp(this.toNative(file.path), join(picked.filePaths[0], file.name), { recursive: true })
    return true
  }
}
