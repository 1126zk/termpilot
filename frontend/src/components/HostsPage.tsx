import { useRef } from 'react'
import { Bot, Plus, Search, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '../stores/useAppStore'
import { cn } from '@/lib/utils'
import { agentOnboardPrompt, copyAgentPrompt } from '../agentPrompt'
import { hostKeyOf } from '../../../shared/host-key'
import { OsIcon, osIconProps } from './OsIcon'
import type { SessionConfig } from '../../../shared/types'

/** 主机页：没有终端标签时的主页。卡片网格列出全部连接，点开即连。 */
export function HostsPage() {
  const sessions = useAppStore((s) => s.sessions)
  const hostNotes = useAppStore((s) => s.hostNotes)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const setEditing = useAppStore((s) => s.setEditing)

  const kw = search.trim().toLowerCase()
  const filtered = kw
    ? sessions.filter(
        (s) =>
          s.name.toLowerCase().includes(kw) ||
          s.host.toLowerCase().includes(kw) ||
          (s.remark ?? '').toLowerCase().includes(kw) ||
          (hostNotes[hostKeyOf(s.host)] ?? '').toLowerCase().includes(kw)
      )
    : sessions

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-col gap-3 py-5 pr-6 pl-25">
        <div className="flex items-center gap-1.5">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-3 text-muted-foreground">
            <Search className="size-4 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索主机"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <button
            type="button"
            title="新建主机"
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setEditing({ action: 'create' })}
          >
            <Plus className="size-5" strokeWidth={2} />
          </button>
        </div>

        <p className="text-xs text-muted-foreground">主机</p>
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {kw ? '没有匹配的主机' : '还没有主机，点上面的 + 新建'}
          </p>
        ) : (
          <div className="grid max-w-5xl grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((session) => (
              <HostCard key={session.id} session={session} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function HostCard(props: { session: SessionConfig }) {
  const session = props.session
  const openSessionTab = useAppStore((s) => s.openSessionTab)
  const editing = useAppStore((s) => s.editing)
  const setEditing = useAppStore((s) => s.setEditing)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const setNotice = useAppStore((s) => s.setNotice)
  const clickTimer = useRef<number>(0)

  // 单击 = 主机信息面板滑出/滑回；双击 = 新开一扇终端（每次都新开）
  const open = () => {
    window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      if (editing?.action === 'edit' && editing.session.id === session.id) setEditing(null)
      else setEditing({ action: 'edit', session })
    }, 250)
  }

  const openFresh = () => {
    window.clearTimeout(clickTimer.current)
    openSessionTab(session, true)
  }

  return (
    <div className="min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            className={cn(
              'group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-muted-foreground/10 px-4 py-3.5 text-left transition-colors hover:bg-muted-foreground/15',
              editing?.action === 'edit' && editing.session.id === session.id && 'ring-2 ring-primary/50'
            )}
            onClick={open}
            onDoubleClick={openFresh}
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted-foreground/15 text-muted-foreground [&_svg]:size-5">
              <OsIcon {...osIconProps(session.os)} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-muted-foreground">{session.name}</span>
              <span className="block truncate text-xs text-muted-foreground">ssh, {session.username}</span>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void copyAgentPrompt(agentOnboardPrompt(), setNotice)}>
            <Bot />
            复制 Agent 提示词
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => deleteSession(session.id)}>
            <Trash2 />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
