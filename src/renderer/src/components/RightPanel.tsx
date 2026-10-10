import { Braces, Folder, History, Palette } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore, type RightPanelPane } from '../stores/useAppStore'
import { FileTree } from './FileTree'
import { SnippetsPanel } from './SnippetsPanel'
import { HistoryPanel } from './HistoryPanel'
import { ThemePanel } from './ThemePanel'

const panes: { id: RightPanelPane; title: string; icon: typeof Folder }[] = [
  { id: 'files', title: '文件', icon: Folder },
  { id: 'snippets', title: '指令片段', icon: Braces },
  { id: 'history', title: '历史指令', icon: History },
  { id: 'theme', title: '主题', icon: Palette }
]

/** 右侧面板：顶部图标行切换四个板块，风格和顶栏按钮一致。 */
export function RightPanel() {
  const pane = useAppStore((s) => s.rightPanelPane)
  const setPane = useAppStore((s) => s.setRightPanelPane)

  return (
    <div className="flex min-h-0 w-80 flex-1 shrink-0 flex-col overflow-hidden rounded-xl bg-card text-sidebar-foreground">
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
