import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Download, Eye, EyeOff, FilePenLine, FolderInput, FolderPlus, FolderSync, FolderUp, Home, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '../stores/useAppStore'
import { FileIcon } from './FileIcon'
import { isImage } from './RemoteEditor'
import { TREE_PATH_MIME } from '../terminal/dropPath'
import { beginTreeMove, finishTreeMove, noteTreeMoveDrop, treeMoveActive } from '../treeMove'
import { PanelConfirm, PanelDialog, useMenuAction } from './PanelDialog'
import { DROP_TARGET_STYLE, dropDirAt, registerDropTree } from '../fileDrop'
import type { RemoteFile, Tab } from '../../../shared/types'
import { MAX_EDIT_BYTES } from '../../../shared/file-listing'

type DirListing = { entries: RemoteFile[]; error?: string }

type FsBackend = {
  list: (dir: string) => Promise<{ path: string; entries: RemoteFile[] }>
  mkdir: (dir: string, name: string) => Promise<void>
  remove: (path: string, kind: RemoteFile['kind']) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  upload: (dir: string) => Promise<number>
  uploadDir: (dir: string) => Promise<number>
  uploadPaths: (dir: string, paths: string[]) => Promise<number>
  download: (file: RemoteFile) => Promise<boolean>
  downloadDir: (file: RemoteFile) => Promise<boolean>
}

/**
 * 一个终端标签一棵文件树：组件收 tab prop，RightPanel 按标签各挂一个实例，
 * 切标签只是显隐，状态（当前目录、展开、选中）互不干扰。
 * SSH 窗口显示服务器文件，本地终端显示本机文件。
 * 当前看得到的树每 3 秒静默重读已展开的目录；自己在树上操作时会让开。
 */
export function FileTree(props: { tab: Tab | null; active?: boolean }) {
  const tab = props.tab
  const local = tab?.kind === 'local'
  const sessionId = local ? null : tab?.sessionId ?? null
  const backendKey = local ? 'local' : sessionId

  const [root, setRoot] = useState('.')
  const [entries, setEntries] = useState<RemoteFile[]>([])
  const [cache, setCache] = useState<Record<string, DirListing>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [making, setMaking] = useState(false)
  const [mkdirTarget, setMkdirTarget] = useState<string | null>(null)
  const [folderError, setFolderError] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<RemoteFile | null>(null)
  // 右键选了重命名/新建文件夹后，菜单关闭时阻止 Radix 把焦点还给列表项，否则弹层的输入框会被顶得失焦
  const panelMenu = useMenuAction()
  const [renameError, setRenameError] = useState('')
  const [removing, setRemoving] = useState<RemoteFile | null>(null)
  const [removeError, setRemoveError] = useState('')
  const [removeBusy, setRemoveBusy] = useState(false)
  const removeInFlight = useRef(false)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const dropRef = useRef<(dir: string, paths: string[]) => void>(() => undefined)
  // 自己发起的列目录把代数加一，进行中的自动刷新结果作废，避免盖掉更新的列表
  const listingGen = useRef(0)
  const seenActive = useRef(false)
  const dragging = useRef(false)
  const refreshRef = useRef<() => Promise<void>>(async () => undefined)
  const treeId = tab?.id ?? ''
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === '1')
  const openRemoteEditor = useAppStore((s) => s.openRemoteEditor)
  const setNotice = useAppStore((s) => s.setNotice)
  const dismissTransfer = useAppStore((s) => s.dismissSftpTransfer)
  const transfers = useAppStore((s) => (sessionId ? s.transfersBySession[sessionId] : undefined)) ?? []

  // 编辑器/预览收不下的文件不开废标签页，点击时就地提示。图片走预览，上限另算
  const openFile = (item: RemoteFile, pin: boolean, readOnly?: boolean) => {
    if (isImage(item.name)) {
      if (item.size > 20 * 1024 * 1024) {
        setNotice('图片超过 20MB，不在预览里打开')
        return
      }
    } else if (item.size > MAX_EDIT_BYTES) {
      setNotice('文件超过 20MB，不在编辑器里打开')
      return
    }
    openRemoteEditor(treeId, local ? null : sessionId, { path: item.path, name: item.name }, pin, readOnly)
  }

  const toggleHidden = () =>
    setShowHidden((v) => {
      localStorage.setItem(HIDDEN_KEY, v ? '0' : '1')
      return !v
    })

  const visible = (items: RemoteFile[]) =>
    showHidden ? items : items.filter((i) => !i.name.startsWith('.'))

  // 统一文件后端：本地终端走 localfs，SSH 窗口走绑了 sessionId 的 sftp
  const fs = useMemo<FsBackend | null>(() => {
    if (local) return window.api.localfs
    if (!sessionId) return null
    const id = sessionId
    const sftp = window.api.sftp
    return {
      list: (dir) => sftp.list(id, dir),
      mkdir: (dir, name) => sftp.mkdir(id, dir, name),
      remove: (path, kind) => sftp.remove(id, path, kind),
      rename: (from, to) => sftp.rename(id, from, to),
      upload: (dir) => sftp.upload(id, dir),
      uploadDir: (dir) => sftp.uploadDir(id, dir),
      uploadPaths: (dir, paths) => sftp.uploadPaths(id, dir, paths),
      download: (file) => sftp.download(id, file),
      downloadDir: (file) => sftp.downloadDir(id, file)
    }
  }, [local, sessionId])

  useEffect(() => {
    if (!treeId) return
    return registerDropTree(treeId, (dir, paths) => {
      setDropDir(null)
      dropRef.current(dir, paths)
    })
  }, [treeId])

  const showRoot = useCallback(
    async (path: string) => {
      if (!fs || !backendKey) return
      const token = ++listingGen.current
      const requested = path.trim().replaceAll('\\', '/') || '.'
      const resolved = tab?.shell === 'wsl' ? await window.api.localfs.resolveWsl(requested) : requested
      const res = await fs.list(resolved)
      if (listingGen.current !== token) return
      setRoot(res.path)
      setEntries(sortEntries(res.entries))
      setCache({})
      setOpen({ [res.path]: true })
      setSelected(res.path)
      setError('')
    },
    [fs, backendKey, tab?.shell]
  )

  const loadRoot = useCallback(
    async (path: string) => {
      setBusy(true)
      setError('')
      try {
        await showRoot(path)
      } catch (e) {
        setError(sftpMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [showRoot]
  )

  useEffect(() => {
    setRoot('.')
    setEntries([])
    setCache({})
    setOpen({})
    setSelected(null)
    setError('')
    setDraft(null)
    setMaking(false)
    setRenaming(null)
    if (!backendKey) return
    void loadRoot('.')
  }, [backendKey, loadRoot])

  const listInto = useCallback(
    async (path: string) => {
      if (!fs) return
      const token = ++listingGen.current
      setLoading((s) => ({ ...s, [path]: true }))
      try {
        const res = await fs.list(path)
        if (listingGen.current !== token) return
        const sorted = sortEntries(res.entries)
        if (path === root) {
          setRoot(res.path)
          setEntries(sorted)
        } else {
          setCache((s) => ({ ...s, [path]: { entries: sorted } }))
        }
      } catch (e) {
        const message = sftpMessage(e)
        if (path === root) setError(message)
        else setCache((s) => ({ ...s, [path]: { entries: [], error: message } }))
      } finally {
        setLoading((s) => ({ ...s, [path]: false }))
      }
    },
    [fs, root]
  )

  const toggle = async (path: string) => {
    if (open[path]) {
      setOpen((s) => ({ ...s, [path]: false }))
      return
    }
    setOpen((s) => ({ ...s, [path]: true }))
    if (path !== root && !cache[path]) await listInto(path)
  }

  const ensureOpen = async (path: string) => {
    setOpen((s) => ({ ...s, [path]: true }))
    await listInto(path)
  }

  const pollState = useRef({ fs, root, open, busy, making, renaming, removing, error, entries, cache })
  pollState.current = { fs, root, open, busy, making, renaming, removing, error, entries, cache }

  // 只刷当前标签、面板开着的那棵树。第一次打开交给上面的 loadRoot，之后切回来立刻补一次。
  useEffect(() => {
    if (!props.active || !backendKey) return
    let stopped = false
    let inflight = false
    const tick = async () => {
      if (stopped || inflight || document.hidden) return
      const cur = pollState.current
      if (!cur.fs || cur.busy || cur.making || cur.renaming || cur.removing || cur.error === NO_SFTP) return
      const token = listingGen.current
      const rootAtStart = cur.root
      inflight = true
      try {
        const res = await cur.fs.list(rootAtStart)
        if (stopped || listingGen.current !== token || pollState.current.root !== rootAtStart) return
        const rootEntries = sortEntries(res.entries)
        const paths = Object.keys(cur.open).filter((p) => cur.open[p] && p !== rootAtStart && p !== res.path)
        const nextCache: Record<string, DirListing> = {}
        await Promise.all(
          paths.map(async (p) => {
            try {
              const child = await cur.fs!.list(p)
              nextCache[p] = { entries: sortEntries(child.entries) }
            } catch (e) {
              nextCache[p] = { entries: [], error: sftpMessage(e) }
            }
          })
        )
        if (stopped || listingGen.current !== token || pollState.current.root !== rootAtStart) return
        const latest = pollState.current
        if (res.path !== latest.root) setRoot(res.path)
        if (!sameFiles(latest.entries, rootEntries)) setEntries(rootEntries)
        if (!sameCache(latest.cache, nextCache, paths)) {
          setCache((prev) => {
            const merged = { ...prev }
            for (const p of paths) merged[p] = nextCache[p]
            return merged
          })
        }
      } catch {
        // 自动刷新失败时留着现在的列表，不把短暂的网络错误盖上去
      } finally {
        inflight = false
      }
    }
    const first = seenActive.current
    seenActive.current = true
    if (first) void tick()
    const timer = window.setInterval(() => void tick(), LISTING_POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [props.active, backendKey])

  if (!fs) {
    return <Hint text="打开一个终端窗口，这里显示那台机器的文件。" />
  }

  const unsupported = !local && error === NO_SFTP

  const commitRename = async (raw: string) => {
    if (!renaming) return
    const name = raw.trim()
    if (!name || name.includes('/') || name.includes('\\')) {
      setRenameError('名称不能为空，也不能包含斜杠')
      return
    }
    if (name === renaming.name) {
      setRenaming(null)
      setRenameError('')
      return
    }
    const slash = renaming.path.lastIndexOf('/')
    const to = slash < 0 ? name : slash === 0 ? `/${name}` : `${renaming.path.slice(0, slash)}/${name}`
    const parent = parentDir(renaming.path) ?? root
    try {
      await fs.rename(renaming.path, to)
      setRenaming(null)
      setRenameError('')
      await listInto(parent)
    } catch (e) {
      setRenameError(sftpMessage(e))
    }
  }

  const remove = async () => {
    const item = removing
    if (!item || removeInFlight.current) return
    removeInFlight.current = true
    setRemoveBusy(true)
    setRemoveError('')
    try {
      await fs.remove(item.path, item.kind)
      setRemoving(null)
      await listInto(parentDir(item.path) ?? root)
    } catch (e) {
      setRemoveError(sftpMessage(e))
    } finally {
      removeInFlight.current = false
      setRemoveBusy(false)
    }
  }

  const uploadFilesInto = async (dir: string) => {
    setBusy(true)
    try {
      await fs.upload(dir)
      await ensureOpen(dir)
    } catch (e) {
      setError(sftpMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const uploadDirInto = async (dir: string) => {
    setBusy(true)
    try {
      await fs.uploadDir(dir)
      await ensureOpen(dir)
    } catch (e) {
      setError(sftpMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // 本机目录之间、以及从系统拖进本机目录树，都是移动。
  const moveLocalInto = async (dir: string, rawPaths: string[]) => {
    if (!fs) return
    const accepted: string[] = []
    for (const raw of rawPaths) {
      const src = normPath(raw)
      if (!src) continue
      if (pathsEqual(src, dir) || pathInside(src, dir)) {
        setNotice('不能移动到自身或它里面的目录')
        continue
      }
      const parent = parentDir(src)
      if (parent && pathsEqual(parent, dir)) {
        setNotice('它已经在这个目录里')
        continue
      }
      accepted.push(src)
    }
    if (accepted.length === 0) return
    setBusy(true)
    try {
      const listing = await fs.list(dir)
      const todo = accepted.filter((src) => {
        const clash = listing.entries.some((item) => namesEqual(item.name, baseName(src)))
        if (clash) setNotice('目标里已经有同名的文件或文件夹')
        return !clash
      })
      if (todo.length === 0) return
      await window.api.localfs.movePaths(dir, todo)
      const parents = [...new Set(todo.map((src) => parentDir(src)).filter((p): p is string => !!p))]
      for (const parent of parents) {
        if (pathsEqual(parent, root) || open[parent]) await listInto(parent)
      }
      await ensureOpen(dir)
    } catch (e) {
      setError(sftpMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // 远程文件树内部：同一台服务器上换目录，走 SFTP 重命名。跨磁盘由服务器拒绝。
  const moveRemoteInto = async (dir: string, raw: string) => {
    if (!fs) return
    const src = posixNorm(raw)
    const destDir = posixNorm(dir)
    if (!src || src === '/' || src === '.') {
      setNotice('不能移动根目录')
      return
    }
    if (posixEqual(src, destDir) || posixInside(src, destDir)) {
      setNotice('不能移动到自身或它里面的目录')
      return
    }
    const parent = parentDir(src)
    if (parent && posixEqual(parent, destDir)) {
      setNotice('它已经在这个目录里')
      return
    }
    const name = baseName(src)
    if (!name || name === '/' || name === '.' || name === '..') {
      setNotice('不能移动根目录')
      return
    }
    setBusy(true)
    try {
      const listing = await fs.list(destDir)
      if (listing.entries.some((item) => item.name === name)) {
        setNotice('目标里已经有同名的文件或文件夹')
        return
      }
      await fs.rename(src, posixJoin(destDir, name))
      if (parent) await listInto(parent)
      await ensureOpen(destDir)
    } catch (e) {
      setError(sftpMessage(e))
    } finally {
      setBusy(false)
    }
  }

  dropRef.current = (dir, paths) => {
    if (treeMoveActive()) {
      if (!local) {
        setNotice('拖到本机目录才是移动，不会复制到服务器')
        noteTreeMoveDrop(Promise.resolve())
        return
      }
      noteTreeMoveDrop(moveLocalInto(dir, paths))
      return
    }
    if (local) {
      void moveLocalInto(dir, paths)
      return
    }
    void (async () => {
      setBusy(true)
      try {
        await fs.uploadPaths(dir, paths)
        await ensureOpen(dir)
      } catch (e) {
        setError(sftpMessage(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const download = async (item: RemoteFile) => {
    try {
      await fs.download(item)
    } catch (e) {
      setError(sftpMessage(e))
    }
  }

  const downloadDir = async (item: RemoteFile) => {
    try {
      await fs.downloadDir(item)
    } catch (e) {
      setError(sftpMessage(e))
    }
  }

  const mkdir = async (raw: string) => {
    const name = raw.trim()
    if (!name || name.includes('/') || name.includes('\\')) {
      setFolderError('名称不能为空，也不能包含斜杠')
      return
    }
    const dest = mkdirTarget ?? root
    try {
      await fs.mkdir(dest, name)
      setMaking(false)
      setFolderError('')
      await ensureOpen(dest)
    } catch (e) {
      setFolderError(sftpMessage(e))
    }
  }

  const refresh = async () => {
    const token = ++listingGen.current
    setBusy(true)
    setError('')
    try {
      const res = await fs.list(root)
      if (listingGen.current !== token) return
      setRoot(res.path)
      setEntries(sortEntries(res.entries))
      const paths = Object.keys(open).filter((p) => open[p] && p !== root && p !== res.path)
      const next: Record<string, DirListing> = {}
      await Promise.all(
        paths.map(async (p) => {
          try {
            const child = await fs.list(p)
            next[p] = { entries: sortEntries(child.entries) }
          } catch (e) {
            next[p] = { entries: [], error: sftpMessage(e) }
          }
        })
      )
      if (listingGen.current !== token) return
      setCache(next)
    } catch (e) {
      setError(sftpMessage(e))
    } finally {
      setBusy(false)
    }
  }

  refreshRef.current = refresh

  const dragLocalOut = (path: string) => {
    if (dragging.current) return
    dragging.current = true
    beginTreeMove()
    void (async () => {
      let failed = ''
      try {
        await window.api.localfs.dragMove([path])
      } catch (error) {
        failed = sftpMessage(error)
      } finally {
        try {
          await finishTreeMove()
          await refreshRef.current()
        } finally {
          dragging.current = false
          if (failed) setNotice(failed)
        }
      }
    })()
  }

  const renderNodes = (items: RemoteFile[], depth: number) =>
    visible(items).map((item) => {
      const isDir = item.kind === 'dir'
      const expanded = isDir && !!open[item.path]
      const listing = cache[item.path]
      return (
        <Fragment key={item.path}>
          <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  role="treeitem"
                  aria-expanded={isDir ? expanded : undefined}
                  aria-selected={selected === item.path}
                  title={
                    item.kind === 'dir'
                      ? item.path
                      : `${item.name}  ${formatSize(item.size)}`
                  }
                  className={`flex h-7 w-full cursor-pointer items-center pr-2 text-left text-sm select-none hover:bg-foreground/5 ${
                    dropDir === item.path ? DROP_HIGHLIGHT : selected === item.path ? 'bg-foreground/10' : ''
                  }`}
                  style={{ paddingLeft: depth * TREE_INDENT }}
                  data-drop-dir={isDir ? item.path : parentDir(item.path) ?? root}
                  draggable
                  onDragStart={(e) => {
                    if (local) {
                      e.preventDefault()
                      dragLocalOut(item.path)
                      return
                    }
                    e.dataTransfer.setData(TREE_PATH_MIME, JSON.stringify({ path: item.path, local: false }))
                    e.dataTransfer.effectAllowed = 'copyMove'
                  }}
                  onContextMenu={() => setSelected(item.path)}
                  onClick={() => {
                    setSelected(item.path)
                    if (isDir) {
                      void toggle(item.path)
                    } else {
                      openFile(item, false)
                    }
                  }}
                  onDoubleClick={() => {
                    if (!isDir) {
                      openFile(item, true)
                    }
                  }}
                >
                  <FileIcon name={item.name} kind={item.kind} open={expanded} />
                  <span className="min-w-0 flex-1 truncate pl-1">{item.name}</span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                onCloseAutoFocus={panelMenu.keepFocusOnClose}
              >
                {item.kind === 'dir' && (
                  <ContextMenuItem onClick={() => void loadRoot(item.path)}>
                    <FolderInput /> 打开此目录
                  </ContextMenuItem>
                )}
                {item.kind === 'dir' && (
                  <ContextMenuItem
                    onClick={() => {
                      panelMenu.openFromMenu(() => {
                        setFolderError('')
                        setMkdirTarget(item.path)
                        setMaking(true)
                      })
                    }}
                  >
                    <FolderPlus /> 新建文件夹
                  </ContextMenuItem>
                )}
                {item.kind === 'dir' && (
                  <ContextMenuItem onClick={() => void uploadFilesInto(item.path)}>
                    <Upload /> 上传文件
                  </ContextMenuItem>
                )}
                {item.kind === 'dir' && (
                  <ContextMenuItem onClick={() => void uploadDirInto(item.path)}>
                    <FolderUp /> 上传文件夹
                  </ContextMenuItem>
                )}
                {item.kind !== 'dir' && (
                  <ContextMenuItem
                    onClick={() => openFile(item, true, true)}
                  >
                    <Eye /> 查看
                  </ContextMenuItem>
                )}
                {item.kind !== 'dir' && !isImage(item.name) && (
                  <ContextMenuItem
                    onClick={() => openFile(item, true, false)}
                  >
                    <FilePenLine /> 编辑
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  onClick={() => {
                    panelMenu.openFromMenu(() => {
                      setRenameError('')
                      setRenaming(item)
                    })
                  }}
                >
                  <Pencil /> 重命名
                </ContextMenuItem>
                {item.kind !== 'dir' && (
                  <ContextMenuItem onClick={() => download(item)}>
                    <Download /> 下载
                  </ContextMenuItem>
                )}
                {item.kind === 'dir' && (
                  <ContextMenuItem onClick={() => downloadDir(item)}>
                    <Download /> 下载
                  </ContextMenuItem>
                )}
                <ContextMenuItem onClick={() => panelMenu.openFromMenu(() => setRemoving(item))}>
                  <Trash2 /> 删除
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          {expanded && (
            <div>
              {loading[item.path] && !listing && (
                <p className="flex h-7 items-center text-xs text-muted-foreground" style={{ paddingLeft: (depth + 1) * TREE_INDENT }}>
                  正在加载
                </p>
              )}
              {listing?.error && (
                <p className="text-[11px] text-destructive" style={{ paddingLeft: (depth + 1) * TREE_INDENT }}>
                  {listing.error}
                </p>
              )}
              {listing && visible(listing.entries).length === 0 && !listing.error && (
                <p className="flex h-7 items-center text-xs text-muted-foreground" style={{ paddingLeft: (depth + 1) * TREE_INDENT }}>
                  空目录
                </p>
              )}
              {listing && renderNodes(listing.entries, depth + 1)}
            </div>
          )}
        </Fragment>
      )
    })

  const rootOpen = !!open[root]
  const displayRoot = tab?.shell === 'wsl' ? wslDisplayPath(root) : root
  const rootName = baseName(displayRoot)

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      style={DROP_TARGET_STYLE}
      data-drop-tree={treeId}
      data-drop-local={local ? '1' : undefined}
      data-drop-dir={root}
      onDragOver={(e) => {
        const fromTree = e.dataTransfer.types.includes(TREE_PATH_MIME)
        if (fromTree) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }
        if (fromTree || e.dataTransfer.types.includes('Files')) setDropDir(dropDirAt(e.target))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDir(null)
      }}
      onDrop={(e) => {
        const dir = dropDirAt(e.target)
        setDropDir(null)
        if (!dir) return
        const raw = e.dataTransfer.getData(TREE_PATH_MIME)
        if (!raw) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        try {
          const item = JSON.parse(raw) as { path: string; local?: boolean }
          if (!item.path) return
          if (local) {
            if (item.local) void moveLocalInto(dir, [item.path])
            return
          }
          if (!item.local) void moveRemoteInto(dir, item.path)
        } catch {
          /* 不是文件树拖出来的 */
        }
      }}
    >
      <div className="flex items-center gap-1 pr-1 pb-1">
        <input
          className="h-8 min-w-0 flex-1 rounded bg-foreground/5 px-2 text-sm outline-none focus:bg-foreground/10"
          value={draft ?? (root === '.' ? '' : displayRoot)}
          placeholder={local && tab?.shell !== 'wsl' ? 'C:\\Users\\...' : '/root 或 /home'}
          title={root === '.' ? '' : displayRoot}
          spellCheck={false}
          onFocus={() => setDraft(root === '.' ? '' : displayRoot)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const path = e.currentTarget.value.trim()
              setDraft(null)
              if (path) void loadRoot(path)
            } else if (e.key === 'Escape') {
              setDraft(null)
            }
          }}
          onBlur={() => setDraft(null)}
        />
        <Button variant="ghost" size="icon-sm" title="回到家目录" disabled={busy} onClick={() => void loadRoot('.')}>
          <Home />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="回到上级目录"
          disabled={busy || !parentDir(root)}
          onClick={() => void loadRoot(parentDir(root)!)}
        >
          <ArrowUp />
        </Button>
        {/* 文件树跳到当前终端所在的目录：从屏幕提示符解析，认不出就提示 */}
        <Button
          variant="ghost"
          size="icon-sm"
          title="同步到终端当前目录"
          disabled={busy || !tab}
          onClick={() => {
            void (async () => {
              if (!tab) return
              try {
                const dir = await window.api.term.cwd(tab.id)
                if (!dir) {
                  setNotice('识别不到终端当前目录')
                  return
                }
                setDraft(null)
                await loadRoot(dir)
              } catch {
                setNotice('识别不到终端当前目录，重启应用后再试')
              }
            })()
          }}
        >
          <FolderSync />
        </Button>
        <Button variant="ghost" size="icon-sm" title="刷新" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={showHidden ? '隐藏以 . 开头的文件' : '显示隐藏文件'}
          onClick={toggleHidden}
        >
          {showHidden ? <Eye /> : <EyeOff />}
        </Button>
      </div>
      {unsupported ? (
        <Hint text="内置 SFTP 没有用起来，机器上原来的文件通道也打不开。改 sshd 需要 root 或免密 sudo。" />
      ) : (
        <>
          {!local && busy && entries.length === 0 && !error && (
            <Hint text="正在通过当前 SSH 连接准备 SFTP，不会另开端口。" />
          )}
          {error && <p className="px-3 pb-1 text-[11px] text-destructive">{error}</p>}
          {!(busy && entries.length === 0 && root === '.') && !(error && entries.length === 0 && root === '.') && (
          <ScrollArea className="min-h-0 flex-1">
            <div
              role="tree"
              className="pb-2"
            >
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    role="treeitem"
                    aria-expanded={rootOpen}
                    aria-selected={selected === root}
                    title={root}
                    className={`flex h-7 w-full cursor-pointer items-center pr-2 text-sm select-none hover:bg-foreground/5 ${
                      dropDir === root ? DROP_HIGHLIGHT : selected === root ? 'bg-foreground/10' : ''
                    }`}
                    style={{ paddingLeft: 0 }}
                    draggable
                    onDragStart={(e) => {
                      if (local) {
                        e.preventDefault()
                        dragLocalOut(root)
                        return
                      }
                      e.dataTransfer.setData(TREE_PATH_MIME, JSON.stringify({ path: root, local: false }))
                      e.dataTransfer.effectAllowed = 'copyMove'
                    }}
                    onContextMenu={() => setSelected(root)}
                    onClick={() => {
                      setSelected(root)
                      void toggle(root)
                    }}
                  >
                    <FileIcon name={rootName} kind="dir" open={rootOpen} />
                    <span className="min-w-0 flex-1 truncate pl-1">{rootName}</span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent
                  onCloseAutoFocus={panelMenu.keepFocusOnClose}
                >
                  {parentDir(root) && (
                    <ContextMenuItem onClick={() => void loadRoot(parentDir(root)!)}>
                      打开上级目录
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    onClick={() => {
                      panelMenu.openFromMenu(() => {
                        setFolderError('')
                        setMkdirTarget(root)
                        setMaking(true)
                      })
                    }}
                  >
                    <FolderPlus /> 新建文件夹
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => void uploadFilesInto(root)}>
                    <Upload /> 上传文件
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => void uploadDirInto(root)}>
                    <FolderUp /> 上传文件夹
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() =>
                      downloadDir({ name: rootName, path: root, kind: 'dir', size: 0, mtime: 0 })
                    }
                  >
                    <Download /> 下载
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {rootOpen && (
                <>
                  {visible(entries).length === 0 && !busy && !error && (
                    <p className="flex h-7 items-center text-xs text-muted-foreground" style={{ paddingLeft: TREE_INDENT }}>
                      空目录
                    </p>
                  )}
                  {renderNodes(entries, 1)}
                </>
              )}
            </div>
          </ScrollArea>
          )}
        </>
      )}
      {transfers.length > 0 && (
        <div className="shrink-0 border-t px-3 py-1">
          {transfers.map((t) => {
            const percent = t.done && !t.error ? 100 : t.total > 0 ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0
            return (
              <div key={t.id} className="grid gap-0.5 py-0.5 text-xs text-muted-foreground">
                <div className="flex items-start gap-1.5">
                  {t.direction === 'up' ? (
                    <Upload className="mt-0.5 size-3 shrink-0" />
                  ) : (
                    <Download className="mt-0.5 size-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 break-all">{t.name}</span>
                  {t.error ? (
                    <span className="min-w-0 shrink-0 text-destructive" title={t.error}>
                      {t.error}
                    </span>
                  ) : (
                    <span className="shrink-0">{percent}%</span>
                  )}
                  <button
                    type="button"
                    title={t.done ? '关闭' : '取消传输'}
                    className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    onClick={() => {
                      if (t.done) dismissTransfer(t.sessionId, t.id)
                      else void window.api.sftp.cancelTransfer(t.id)
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
                <div className="h-0.5 rounded-full bg-foreground/10">
                  <div
                    className={`h-full rounded-full ${t.error ? 'bg-destructive' : 'bg-foreground/40'}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                {!t.error && t.total > 0 && (
                  <div className="flex gap-2 pl-[18px] tabular-nums">
                    <span className="min-w-0 flex-1">
                      {t.done ? formatSize(t.total) : `${formatSize(t.transferred)} / ${formatSize(t.total)}`}
                    </span>
                    {!t.done && t.speed > 0 && (
                      <span className="shrink-0">
                        {formatSize(Math.round(t.speed))}/s · 剩余 {formatEta((t.total - t.transferred) / t.speed)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <PanelDialog
        open={renaming !== null}
        title="重命名"
        initial={renaming?.name ?? ''}
        placeholder="新的名称"
        error={renameError}
        onClose={() => {
          setRenaming(null)
          setRenameError('')
        }}
        onSave={(value) => void commitRename(value)}
      />
      <PanelDialog
        open={making}
        title="新建文件夹"
        initial=""
        placeholder="文件夹名"
        error={folderError}
        onClose={() => {
          setMaking(false)
          setFolderError('')
        }}
        onSave={(value) => void mkdir(value)}
      />
      <PanelConfirm
        open={removing !== null}
        title={removing?.kind === 'dir' ? '删除文件夹' : '删除文件'}
        message={
          removing?.kind === 'dir'
            ? `删除 ${removing.name} 及其中的所有文件？删除后无法恢复。`
            : `删除 ${removing?.name ?? ''}？删除后无法恢复。`
        }
        error={removeError}
        busy={removeBusy}
        onClose={() => {
          setRemoving(null)
          setRemoveError('')
        }}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/** 文件树自动重读间隔。3 秒能跟上终端里刚改的文件，又不会连续列远程目录。 */
const LISTING_POLL_MS = 3000

/** 每级缩进 12px，图标自成一列。 */
const TREE_INDENT = 12
/** 拖文件经过时，会上传进去的那个目录行 */
const DROP_HIGHLIGHT = 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/50'

function sameFiles(a: RemoteFile[], b: RemoteFile[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.name !== y.name || x.path !== y.path || x.kind !== y.kind || x.size !== y.size || x.mtime !== y.mtime) {
      return false
    }
  }
  return true
}

function sameCache(prev: Record<string, DirListing>, next: Record<string, DirListing>, paths: string[]): boolean {
  for (const p of paths) {
    const a = prev[p]
    const b = next[p]
    if (!a || !b || (a.error ?? '') !== (b.error ?? '') || !sameFiles(a.entries, b.entries)) return false
  }
  return true
}

function sortEntries(items: RemoteFile[]): RemoteFile[] {
  return [...items].sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1
    const bd = b.kind === 'dir' ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
}

function posixNorm(path: string): string {
  const trimmed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return trimmed || '/'
}

function posixEqual(a: string, b: string): boolean {
  return posixNorm(a) === posixNorm(b)
}

function posixInside(parent: string, child: string): boolean {
  const base = posixNorm(parent)
  const target = posixNorm(child)
  const prefix = base === '/' ? '/' : `${base}/`
  return target.startsWith(prefix)
}

function posixJoin(dir: string, name: string): string {
  const base = posixNorm(dir)
  return base === '/' ? `/${name}` : `${base}/${name}`
}

function normPath(path: string): string {
  const trimmed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return trimmed || '/'
}

function pathsEqual(a: string, b: string): boolean {
  const x = normPath(a)
  const y = normPath(b)
  return window.api.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function namesEqual(a: string, b: string): boolean {
  return window.api.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** child 是否落在 parent 里面（不含两者相同）。 */
function pathInside(parent: string, child: string): boolean {
  const base = normPath(parent)
  const target = normPath(child)
  const prefix = base === '/' ? '/' : `${base}/`
  if (window.api.platform === 'win32') return target.toLowerCase().startsWith(prefix.toLowerCase())
  return target.startsWith(prefix)
}

function wslDisplayPath(path: string): string {
  const match = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i.exec(path)
  return match ? (match[1] ?? '/') : path
}

function baseName(path: string): string {
  if (path === '/' || path === '.') return path
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  return slash < 0 ? trimmed : trimmed.slice(slash + 1) || '/'
}

function parentDir(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed || trimmed === '/' || /^\/\/(?:wsl\.localhost|wsl\$)(?:\/[^/]+)?$/i.test(trimmed)) return null
  // POSIX 绝对路径或 Windows 盘符路径（C:/...），其余（相对路径等）没有上级
  if (!trimmed.startsWith('/') && !/^[A-Za-z]:(\/|$)/.test(trimmed)) return null
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return null
  if (slash === 0) return '/'
  const parent = trimmed.slice(0, slash)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

function Hint(props: { text: string }) {
  return <p className="px-3 py-6 text-center text-xs leading-5 text-muted-foreground">{props.text}</p>
}

const HIDDEN_KEY = 'termpilot.showHidden'

const NO_SFTP = '这台机器没有 SFTP'

const FILE_ERROR_TEXT: Record<string, string> = {
  'The specified path is invalid.': '路径无效',
  'The system cannot find the path specified.': '路径不存在',
  'The system cannot find the file specified.': '文件不存在',
  'Access is denied.': '没有访问权限',
  'Cannot create a file when that file already exists.': '文件或目录已存在',
  'The filename, directory name, or volume label syntax is incorrect.': '文件名、目录名或卷标语法不正确',
  'The process cannot access the file because it is being used by another process.': '文件正被其他程序占用',
  'There is not enough space on the disk.': '磁盘空间不足'
}

const FILE_ERROR_OPS: Record<string, string> = {
  open: '打开',
  readdirent: '读取目录',
  mkdir: '创建目录',
  remove: '删除',
  removeall: '删除目录',
  rename: '重命名',
  read: '读取',
  write: '写入',
  stat: '读取状态',
  lstat: '读取状态'
}

function localizeFileError(raw: string): string {
  for (const [english, chinese] of Object.entries(FILE_ERROR_TEXT)) {
    if (!raw.endsWith(english)) continue
    const match = /^(\S+)\s+(.*):\s*$/.exec(raw.slice(0, -english.length))
    if (!match) return chinese
    return `${FILE_ERROR_OPS[match[1]!] ?? match[1]} ${match[2]} 失败：${chinese}`
  }
  return raw
}

function sftpMessage(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    ''
  )
  if (/Received exit code 127|establishing SFTP/i.test(raw)) return NO_SFTP
  return localizeFileError(raw)
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 剩余秒数 → 1:05 / 1:02:30 */
function formatEta(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
