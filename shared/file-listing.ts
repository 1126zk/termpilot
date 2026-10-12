import type { RemoteFile } from './types'

/** 编辑器只打开 1.5MB 以内的文本文件。先按大小挡，读出内容后再按 NUL 字节判二进制。 */
export const MAX_EDIT_BYTES = 1_500_000

export function assertEditSize(size: number): void {
  if (size > MAX_EDIT_BYTES) throw new Error('文件超过 1.5MB，不在编辑器里打开')
}

export function assertTextBuffer(buf: Uint8Array): void {
  if (buf.includes(0)) throw new Error('这是二进制文件，不能用文本编辑器打开')
}

/** 目录在前，同级按名字排。 */
export function compareRemoteFiles(a: RemoteFile, b: RemoteFile): number {
  if (a.kind === 'dir' && b.kind !== 'dir') return -1
  if (a.kind !== 'dir' && b.kind === 'dir') return 1
  return a.name.localeCompare(b.name)
}
