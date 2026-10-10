import { useState, type ComponentProps, ReactNode } from 'react'
import { Pencil, Plus, Search, Settings } from 'lucide-react'
import { SidebarContent, SidebarGroup, SidebarGroupContent, useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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

/**
 * 应用侧边栏。不用 shadcn Sidebar 的 fixed 布局：
 * 那一层会和文档流占位各画一次，在 Electron 里左边会露出重影。
 * 收纳状态仍走 SidebarProvider。
 */
export function AppSidebar() {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  return (
    <div
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200',
        collapsed ? 'w-12 min-w-12 max-w-12' : 'w-64 min-w-64 max-w-64'
      )}
    >
      {collapsed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 py-1">
          <div className="mt-auto flex flex-col items-center gap-1">
            <Button variant="ghost" size="icon-sm" title="设置" onClick={() => setSettingsOpen(true)}>
              <Settings />
            </Button>
          </div>
        </div>
      ) : (
        <>
          <SidebarContent className="min-w-0 overflow-x-hidden">
            <ConnectTree />
          </SidebarContent>
          <div className="flex items-center gap-1 border-t px-2 py-2">
            <button
              type="button"
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-4" />
              设置
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ConnectTree() {
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
    <>
      <div className="flex items-center gap-1 px-2 pb-1">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-sidebar-accent px-2 text-muted-foreground">
          <Search className="size-3.5 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索连接"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <button
          type="button"
          title="新建连接"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => setEditing({ action: 'create' })}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <SidebarGroup className="px-2 py-0.5">
        <SidebarGroupContent className="grid min-w-0 gap-0.5">
          {filtered.map((session) => (
            <SessionNode key={session.id} session={session} />
          ))}
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

function SessionNode(props: { session: SessionConfig }) {
  const session = props.session
  const selectedId = useAppStore((s) => s.selectedSessionId)
  const openSessionTab = useAppStore((s) => s.openSessionTab)
  const setEditing = useAppStore((s) => s.setEditing)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const selectSession = useAppStore((s) => s.selectSession)
  const setSessionRemark = useAppStore((s) => s.setSessionRemark)
  const setNotice = useAppStore((s) => s.setNotice)
  const [editingRemark, setEditingRemark] = useState(false)

  const remark = session.remark?.trim() ?? ''

  return (
    <div className="min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TreeRow
            label={session.name}
            hint={remark}
            icon={<OsIcon {...osIconProps(session.os)} />}
            active={selectedId === session.id}
            onClick={() => {
              selectSession(session.id)
              openSessionTab(session)
            }}
            addon={
              <button
                type="button"
                title={`编辑「${session.name}」`}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  setEditing({ action: 'edit', session })
                }}
              >
                <Pencil className="size-3" />
              </button>
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void copyAgentPrompt(connectionAgentPrompt(session), setNotice)}>
            复制为 Agent 提示词
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => openSessionTab(session)}>打开</ContextMenuItem>
          <ContextMenuItem onClick={() => openSessionTab(session, true)}>新开一扇终端</ContextMenuItem>
          <ContextMenuItem onClick={() => openAfterMenu(() => setEditingRemark(true))}>备注</ContextMenuItem>
          <ContextMenuItem onClick={() => setEditing({ action: 'edit', session })}>编辑</ContextMenuItem>
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
        initial={remark}
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

function TreeRow({
  label,
  hint,
  active,
  icon,
  addon,
  onClick,
  className,
  style,
  ...rest
}: {
  label: string
  hint?: string
  active?: boolean
  icon?: ReactNode
  addon?: ReactNode
  onClick: () => void
} & Omit<ComponentProps<'div'>, 'onClick'>) {
  return (
    <div
      {...rest}
      title={hint || undefined}
      className={cn(
        'flex h-9 w-full min-w-0 items-center gap-1 overflow-hidden rounded-md px-2 text-[13px] hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent',
        className
      )}
      style={style}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left" onClick={onClick}>
        {icon && <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {addon}
    </div>
  )
}
