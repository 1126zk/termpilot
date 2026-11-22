import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { SessionConfig, Tab } from '../../../../shared/types'
import { useAppStore } from '../../stores/useAppStore'
import { FileTree } from '../FileTree'
import type { ToolProps } from '../ToolsPage'

function usePane(side: 'left' | 'right') {
  const sessions = useAppStore((s) => s.sessions)
  const [hostId, setHostId] = useState('')
  const session = sessions.find((item) => item.id === hostId)
  const tab: Tab | null = session
    ? {
        id: `transfer-${side}`,
        sessionId: session.id,
        kind: 'ssh',
        title: session.name
      }
    : null
  return { sessions, hostId, setHostId, tab }
}

function HostSelect(props: {
  sessions: SessionConfig[]
  hostId: string
  onChange: (id: string) => void
}) {
  return (
    <Select value={props.hostId || undefined} onValueChange={props.onChange}>
      <SelectTrigger className="h-8 w-full text-sm">
        <SelectValue placeholder="选择主机" />
      </SelectTrigger>
      <SelectContent>
        {props.sessions.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name || `${item.username}@${item.host}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 左右各挂一棵现成的文件树。跨栏拖放先不传。 */
export function TransferTool(_props: ToolProps) {
  const left = usePane('left')
  const right = usePane('right')
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex">
        <div className="min-w-0 flex-1 px-3 pt-3 pb-2">
          <HostSelect sessions={left.sessions} hostId={left.hostId} onChange={left.setHostId} />
        </div>
        <div className="min-w-0 flex-1 px-3 pt-3 pb-2">
          <HostSelect sessions={right.sessions} hostId={right.hostId} onChange={right.setHostId} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-2">
          <FileTree tab={left.tab} detached />
        </div>
        <div className="mb-4 mt-1 w-0.5 shrink-0 bg-foreground/40" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-2">
          <FileTree tab={right.tab} detached />
        </div>
      </div>
    </div>
  )
}
