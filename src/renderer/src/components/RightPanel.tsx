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
    <div className="flex w-80 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        {panes.map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            className={cn(
              'flex h-8 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              pane === item.id && 'bg-accent text-foreground'
            )}
            onClick={() => setPane(item.id)}
          >
            <item.icon className="size-4" />
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
