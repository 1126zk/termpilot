import { useRef } from 'react'
import { Braces, Folder, History, Palette } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore, type RightPanelPane } from '../stores/useAppStore'
import { FileTree } from './FileTree'
import { SnippetsPanel } from './SnippetsPanel'
import { HistoryPanel } from './HistoryPanel'
import { ThemePanel } from './ThemePanel'
import { SessionFormPanel } from './SessionForm'

const panes: { id: RightPanelPane; title: string; icon: typeof Folder }[] = [
  { id: 'files', title: '文件', icon: Folder },
  { id: 'snippets', title: '指令片段', icon: Braces },
  { id: 'history', title: '历史指令', icon: History },
  { id: 'theme', title: '主题', icon: Palette }
]

/** 右侧面板：顶部图标行切换四个板块，风格和顶栏按钮一致。新建/编辑主机时整块换成表单。 */
export function RightPanel(props: { open: boolean }) {
  const pane = useAppStore((s) => s.rightPanelPane)
  const setPane = useAppStore((s) => s.setRightPanelPane)
  const editing = useAppStore((s) => s.editing)
  // 收起动画期间冻结开着时的内容：表单关就留住表单，文件面板关就留住文件面板，
  // 否则滑回的 200ms 里内容会闪成另一种
  const lastEditing = useRef(editing)
  if (editing) lastEditing.current = editing
  const wasForm = useRef(Boolean(editing))
  if (props.open) wasForm.current = Boolean(editing)
  const formState = (props.open ? Boolean(editing) : wasForm.current)
    ? (editing ?? lastEditing.current)
    : null

  if (formState) {
    return (
      <div className="flex min-h-0 w-full flex-1 shrink-0 flex-col overflow-hidden rounded-xl bg-card shadow-lg shadow-black/30 text-sidebar-foreground">
        <SessionFormPanel frozen={formState} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 w-full flex-1 shrink-0 flex-col overflow-hidden rounded-xl bg-card shadow-lg shadow-black/30 text-sidebar-foreground">
      <div className="flex shrink-0 items-center px-2 py-1.5">
        {panes.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            className="group flex flex-1 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setPane(item.id)}
          >
            <span
              className={cn(
                'flex size-9 items-center justify-center rounded-md transition-colors group-hover:bg-accent',
                pane === item.id && 'bg-primary/15 text-primary group-hover:bg-primary/15'
              )}
            >
              <item.icon className="size-4" />
            </span>
          </button>
        ))}
      </div>
      {pane === 'files' && <FileTree />}
      {pane === 'snippets' && <SnippetsPanel />}
      {pane === 'history' && <HistoryPanel />}
      {pane === 'theme' && <ThemePanel />}
    </div>
  )
}
