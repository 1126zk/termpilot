/**
 * 本机文件树发起的拖放是移动。OLE 拖放在 Go 里阻塞到松手，
 * 窗口内的落点要等 OnFileDrop 回来再 MoveInto，所以这里留一个短窗口。
 */

let active = false
let pending: Promise<void> | null = null

export function beginTreeMove(): void {
  active = true
  pending = null
}

export function treeMoveActive(): boolean {
  return active
}

export function noteTreeMoveDrop(task: Promise<void>): void {
  if (!active) return
  pending = task
}

/** 等窗口内落点登记并完成。拖到窗口外时不会有落点。 */
export async function finishTreeMove(): Promise<void> {
  const start = Date.now()
  while (pending == null && Date.now() - start < 400) {
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  const task = pending
  active = false
  pending = null
  if (task) await task
}
