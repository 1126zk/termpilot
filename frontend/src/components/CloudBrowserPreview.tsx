import { forwardRef } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** width 为 null 时和终端平分（flex:1），否则按像素宽度占右侧。 */
export const CloudBrowserPreview = forwardRef<HTMLElement, { termId: string; width: number | null }>(function CloudBrowserPreview(
  props,
  ref
) {
  return (
    <section
      ref={ref}
      className={
        props.width == null
          ? 'flex min-h-0 min-w-0 flex-1 flex-col border-l border-border'
          : 'flex min-h-0 min-w-0 flex-col border-l border-border'
      }
      style={props.width == null ? undefined : { width: props.width }}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Globe className="size-8" />
        <p>这台服务器没有安装云浏览器</p>
        <Button size="sm" disabled>
          一键安装云浏览器
        </Button>
      </div>
    </section>
  )
})
