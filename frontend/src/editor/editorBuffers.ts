export interface EditorBuffer {
  text: string
  saved: string
  loaded: boolean
  error: string
}

const buffers = new Map<string, EditorBuffer>()

/** 文件标签跟着终端标签走，同一个文件在两个终端里各开一份 */
export function editorKey(termId: string, sessionId: string | null, path: string): string {
  return `${termId}\n${sessionId ?? 'local'}\n${path}`
}

export function readBuffer(key: string): EditorBuffer | undefined {
  return buffers.get(key)
}

export function writeBuffer(key: string, buffer: EditorBuffer): void {
  buffers.set(key, buffer)
}

export function dropBuffer(key: string): void {
  buffers.delete(key)
}
