import { useState } from 'react'
import { Pencil, Plus, Search } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '../stores/useAppStore'
import { connectionAgentPrompt, copyAgentPrompt } from '../agentPrompt'
import { hostKeyOf } from '../../../shared/host-key'
import { openAfterMenu, RemarkDialog } from './RemarkDialog'
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-5">
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
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
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
  const selectSession = useAppStore((s) => s.selectSession)
  const setEditing = useAppStore((s) => s.setEditing)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const setSessionRemark = useAppStore((s) => s.setSessionRemark)
  const setNotice = useAppStore((s) => s.setNotice)
  const [editingRemark, setEditingRemark] = useState(false)

  const open = () => {
    selectSession(session.id)
    openSessionTab(session)
  }

  return (
    <div className="min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            className="group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted-foreground/10"
            onClick={open}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary [&_svg]:size-4.5">
              <OsIcon {...osIconProps(session.os)} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold">{session.name}</span>
              <span className="block truncate text-xs text-muted-foreground">ssh, {session.username}</span>
            </span>
            <button
              type="button"
              title={`编辑「${session.name}」`}
              className="invisible flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground group-hover:visible hover:bg-muted-foreground/10 hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation()
                setEditing({ action: 'edit', session })
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={open}>打开</ContextMenuItem>
          <ContextMenuItem onClick={() => openSessionTab(session, true)}>新开一扇终端</ContextMenuItem>
          <ContextMenuItem onClick={() => openAfterMenu(() => setEditingRemark(true))}>备注</ContextMenuItem>
          <ContextMenuItem onClick={() => setEditing({ action: 'edit', session })}>编辑</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void copyAgentPrompt(connectionAgentPrompt(session), setNotice)}>
            复制为 Agent 提示词
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => deleteSession(session.id)}>
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RemarkDialog
        open={editingRemark}
        title="备注"
        description={`给「${session.name}」写一句，方便以后认出它。留空就是清掉。`}
        initial={session.remark?.trim() ?? ''}
        placeholder="这条连接是干什么的"
        onOpenChange={setEditingRemark}
        onSave={(value) => {
          setEditingRemark(false)
          void setSessionRemark(session, value)
        }}
      />
    </div>
  )
}
