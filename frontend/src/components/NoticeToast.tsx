import { useAppStore } from '../stores/useAppStore'

/** 右上角浮动小通知：复制成功、截图中等提示，2 秒后自动消失。 */
export function NoticeToast() {
  const notice = useAppStore((s) => s.notice)
  if (!notice) return null
  return (
    <div className="fixed top-14 right-4 z-50 max-h-24 max-w-sm overflow-hidden break-all rounded-lg bg-card px-3 py-2 text-xs text-foreground shadow-lg shadow-black/30 ring-1 ring-foreground/10">
      {notice}
    </div>
  )
}
