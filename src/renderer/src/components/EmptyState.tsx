import { TerminalSquare } from 'lucide-react'

/** 无标签页时的空状态 */
export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <TerminalSquare className="size-10" strokeWidth={1.25} />
      <p className="text-sm">点标签栏右侧 + 新建终端，或从左侧选择连接</p>
    </div>
  )
}
