import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import DOMPurify from 'dompurify'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/useAppStore'
import { capturePositions, dropIndex, moveTo, startPointerDrag, useFlipSlide } from '../flip'

const STORAGE_KEY = 'termpilot.tool.notes'
const DB_NAME = 'termpilot.notes'
const STORE = 'images'
/** 存盘时图片不带 blob 地址，只留这个占位，打开时再换成库里的图 */
const PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

interface Note {
  id: string
  title: string
  body: string
  /** 正文是编辑器产出的 HTML。旧笔记只有纯文本 */
  rich?: boolean
}

function oneLine(text: string) {
  return text.replace(/\s*\n+\s*/g, ' ')
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sanitize(html: string) {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-note-img'] })
}

function toEditorHtml(note: Note) {
  if (!note.body) return ''
  if (!note.rich) return note.body.split('\n').map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`).join('')
  return blocksFromHtml(note.body)
}

/** 把 <br> 拆成一行一个块，行号才能贴住每一行。已经是块的不动。 */
function blocksFromHtml(html: string) {
  const root = document.createElement('div')
  root.innerHTML = sanitize(html)
  if (!root.childNodes.length) return ''
  const onlyBlocks = [...root.childNodes].every(
    (node) => node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'IMG')
  )
  if (onlyBlocks) return root.innerHTML
  const parts: string[] = []
  let bucket = document.createElement('div')
  const flush = () => {
    if (!bucket.childNodes.length) bucket.appendChild(document.createElement('br'))
    parts.push(bucket.outerHTML)
    bucket = document.createElement('div')
  }
  for (const node of [...root.childNodes]) {
    if (node instanceof HTMLBRElement) flush()
    else bucket.appendChild(node)
  }
  if (bucket.childNodes.length) flush()
  return parts.join('')
}

function imageIds(html: string) {
  if (!html) return []
  const template = document.createElement('template')
  template.innerHTML = html
  return [...template.content.querySelectorAll('img[data-note-img]')]
    .map((img) => img.getAttribute('data-note-img') ?? '')
    .filter(Boolean)
}

function serialize(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement
  liftNewlines(clone)
  for (const img of clone.querySelectorAll('img')) {
    const id = img.getAttribute('data-note-img')
    if (!id) {
      img.remove()
      continue
    }
    img.setAttribute('src', PLACEHOLDER)
    img.setAttribute('alt', '')
  }
  const text = (clone.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  if (!text && !clone.querySelector('img') && !hasLineBreaks(clone)) return ''
  return sanitize(clone.innerHTML)
}

/** 文本节点里的换行写成 <br>，再灌回编辑器时才不会被折成一行。 */
function liftNewlines(root: HTMLElement) {
  const texts: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text)
  for (const text of texts) {
    if (!text.data.includes('\n')) continue
    const parts = text.data.split('\n')
    const frag = document.createDocumentFragment()
    parts.forEach((part, index) => {
      if (index > 0) frag.append(document.createElement('br'))
      if (part) frag.append(document.createTextNode(part))
    })
    text.replaceWith(frag)
  }
}

/** 只按回车、一行字都没有，这些空行也要留下。空编辑器里浏览器自带的那一个 <br> 不算。 */
function hasLineBreaks(el: HTMLElement) {
  const blocks = [...el.children].filter((node) => node.tagName === 'DIV' || node.tagName === 'P').length
  return blocks > 1 || el.querySelectorAll('br').length > 1
}

function readNotes(): Note[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Note[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        title: typeof item.title === 'string' ? oneLine(item.title).trim() : '',
        body: typeof item.body === 'string' ? item.body : '',
        rich: item.rich === true
      }))
  } catch {
    return []
  }
}

function label(note: Note) {
  return note.title.trim() || '无标题'
}

function autoNumber(title: string) {
  const match = title.trim().match(/^笔记(\d+)$/)
  return match ? Number(match[1]) : null
}

function nextAutoTitle(notes: Note[]) {
  const used = new Set<number>()
  for (const note of notes) {
    const number = autoNumber(note.title)
    if (number != null) used.add(number)
  }
  let number = 1
  while (used.has(number)) number += 1
  return `笔记${number}`
}

function fillAutoTitles(notes: Note[]) {
  let max = 0
  for (const note of notes) {
    const number = autoNumber(note.title)
    if (number != null) max = Math.max(max, number)
  }
  return notes.map((note) => {
    const title = note.title.trim()
    if (title && title !== '无标题') return note
    max += 1
    return { ...note, title: `笔记${max}` }
  })
}

function blankNote(title: string): Note {
  return { id: crypto.randomUUID(), title, body: '' }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        dbPromise = null
        reject(request.error)
      }
    })
  }
  return dbPromise
}

async function putImage(id: string, blob: Blob) {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function getImage(id: string) {
  const db = await openDb()
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(id)
    request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

async function deleteImage(id: string) {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // 图已经不在了就不用再报
  }
}

function dropImages(html: string) {
  for (const id of imageIds(html)) void deleteImage(id)
}

async function compressImage(file: Blob) {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86))
    if (webp) return webp
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86))
    return jpeg ?? file
  } finally {
    bitmap.close()
  }
}

function imageFromEvent(event: React.ClipboardEvent) {
  for (const item of event.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  for (const file of event.clipboardData.files) {
    if (file.type.startsWith('image/')) return file
  }
  return null
}

function caretRange(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return null
  return range.cloneRange()
}

function insertImage(el: HTMLElement, range: Range | null, id: string, url: string) {
  const img = document.createElement('img')
  img.dataset.noteImg = id
  img.src = url
  img.alt = ''
  img.draggable = false
  const br = document.createElement('br')
  if (range) {
    range.deleteContents()
    range.insertNode(br)
    range.insertNode(img)
    const after = document.createRange()
    after.setStartAfter(br)
    after.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(after)
    return
  }
  el.append(img, br)
}

function logicalLineCount(el: HTMLElement) {
  let text = el.innerText.replace(/\u00a0/g, ' ')
  if (text.endsWith('\n')) text = text.slice(0, -1)
  if (!text && !el.querySelector('br, img')) return 1
  return Math.max(1, text ? text.split('\n').length : 1)
}

type LineMark = { top: number; node: Node }

/** 每一硬换行的顶部，相对编辑框。包在同一个 div 里的 <br> 也要算。 */
function readLineMarks(el: HTMLElement): { marks: LineMark[]; synthetic: boolean } {
  const base = el.getBoundingClientRect().top
  const marks: LineMark[] = []
  const add = (top: number, node: Node) => {
    const rounded = Math.round(top)
    if (marks.some((item) => Math.abs(item.top - rounded) <= 1)) return
    marks.push({ top: rounded, node })
  }
  const textTop = (node: Text) => {
    if (!(node.textContent ?? '').length) return
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, node.textContent?.length ?? 0)
    const rect = range.getClientRects()[0]
    if (rect) add(rect.top - base, node)
  }
  const visit = (node: Node) => {
    if (node instanceof HTMLBRElement) {
      const range = document.createRange()
      range.setStartBefore(node)
      range.setEndAfter(node)
      const short = [...range.getClientRects()].filter((rect) => rect.height > 0 && rect.height <= 40)
      const rect = short[short.length - 1]
      const prev = node.previousElementSibling
      if (prev instanceof HTMLImageElement) {
        const imageBottom = prev.getBoundingClientRect().bottom - base
        if (!rect || rect.top - base < imageBottom - 1) {
          add(imageBottom, node)
          return
        }
      }
      if (rect) {
        add(rect.top - base, node)
        return
      }
      const host = node.parentElement
      if (host && host !== el) add(host.getBoundingClientRect().top - base, node)
      return
    }
    if (node instanceof HTMLImageElement) {
      add(node.getBoundingClientRect().top - base, node)
      return
    }
    if (node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P')) {
      const nested = [...node.childNodes].some(
        (kid) =>
          kid instanceof HTMLBRElement ||
          (kid instanceof HTMLElement && (kid.tagName === 'DIV' || kid.tagName === 'P' || kid.tagName === 'IMG'))
      )
      if (!nested) {
        add(node.getBoundingClientRect().top - base, node)
        return
      }
      for (const kid of node.childNodes) visit(kid)
      return
    }
    if (node.nodeType === Node.TEXT_NODE) textTop(node as Text)
  }
  for (const node of el.childNodes) visit(node)
  marks.sort((a, b) => a.top - b.top)
  const style = getComputedStyle(el)
  const lineHeight = parseFloat(style.lineHeight)
  const pad = parseFloat(style.paddingTop) || 0
  const logical = logicalLineCount(el)
  // 只在几乎没量到行时才按行高补。空行的 <div><br> 会让 innerText 多算一行，不能拿它盖掉已经量准的位置。
  if (marks.length <= 1 && logical > marks.length && Number.isFinite(lineHeight) && lineHeight > 0 && !el.querySelector('img')) {
    return {
      synthetic: true,
      marks: Array.from({ length: logical }, (_, index) => ({ top: Math.round(pad + index * lineHeight), node: el }))
    }
  }
  if (marks.length) return { synthetic: false, marks }
  return { synthetic: false, marks: [{ top: pad, node: el }] }
}

function sameTops(a: number[], b: number[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** 光标落在第几行。图片的光标矩形会从图片顶拉到光标，不能拿矩形顶去对行。 */
function markIndex(el: HTMLElement, marks: LineMark[]): number | null {
  const sel = window.getSelection()
  if (!sel?.focusNode || !el.contains(sel.focusNode)) return null
  const focus = sel.focusNode
  const caret = document.createRange()
  try {
    const max = focus.nodeType === Node.TEXT_NODE ? (focus.textContent?.length ?? 0) : focus.childNodes.length
    caret.setStart(focus, Math.max(0, Math.min(sel.focusOffset, max)))
  } catch {
    return null
  }
  caret.collapse(true)
  let index = 0
  for (let i = 0; i < marks.length; i++) {
    const node = marks[i].node
    if (!node.isConnected || node === el) continue
    const start = document.createRange()
    try {
      start.setStartBefore(node)
    } catch {
      continue
    }
    start.collapse(true)
    if (caret.compareBoundaryPoints(Range.START_TO_START, start) < 0) break
    index = i
  }
  return index
}

function lineBox(el: HTMLElement, marks: LineMark[], index: number) {
  const lineTop = marks[index].top
  let bottom = marks[index + 1]?.top ?? lineTop + 22
  const node = marks[index].node
  if (node instanceof HTMLImageElement) {
    const imageBottom = Math.round(node.getBoundingClientRect().bottom - el.getBoundingClientRect().top)
    if (imageBottom > lineTop) bottom = Math.max(bottom, imageBottom)
  }
  return { top: lineTop, height: Math.max(bottom - lineTop, 1) }
}

function caretTop(el: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel?.focusNode || !el.contains(sel.focusNode)) return null
  const range = document.createRange()
  try {
    range.setStart(sel.focusNode, sel.focusOffset)
  } catch {
    return null
  }
  range.collapse(true)
  const base = el.getBoundingClientRect().top
  const rect = range.getClientRects()[0]
  if (rect && rect.height > 0) return rect.top - base
  const host = sel.focusNode instanceof HTMLElement ? sel.focusNode : sel.focusNode.parentElement
  if (!host || !el.contains(host) || host === el) return parseFloat(getComputedStyle(el).paddingTop) || 0
  return host.getBoundingClientRect().top - base
}

function lineAt(tops: number[], top: number) {
  let index = 0
  let best = Infinity
  tops.forEach((item, i) => {
    const distance = Math.abs(item - top)
    if (distance < best) {
      best = distance
      index = i
    }
  })
  const lineTop = tops[index] ?? top
  const height = tops[index + 1] != null ? Math.max(tops[index + 1] - lineTop, 1) : 22
  return { top: lineTop, height }
}

function NoteEditor(props: { note: Note; autoFocus: boolean; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const urls = useRef<string[]>([])
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange
  const [tops, setTops] = useState<number[]>([0])
  const [current, setCurrent] = useState<{ top: number; height: number } | null>(null)
  const marksRef = useRef<{ marks: LineMark[]; synthetic: boolean }>({ marks: [], synthetic: false })
  const measure = () => {
    const el = ref.current
    if (!el) return
    const next = readLineMarks(el)
    marksRef.current = next
    const topsOnly = next.marks.map((mark) => mark.top)
    setTops((prev) => (sameTops(prev, topsOnly) ? prev : topsOnly))
    trackRef.current()
  }
  const measureRef = useRef(measure)
  measureRef.current = measure
  const trackRef = useRef(() => {})
  const track = () => {
    const el = ref.current
    if (!el || document.activeElement !== el) {
      setCurrent((prev) => (prev == null ? prev : null))
      return
    }
    const { marks, synthetic } = marksRef.current
    let next: { top: number; height: number } | null = null
    if (!synthetic) {
      const index = markIndex(el, marks)
      if (index != null && marks[index]) next = lineBox(el, marks, index)
    } else {
      const top = caretTop(el)
      if (top != null) next = lineAt(marks.map((mark) => mark.top), top)
    }
    if (!next) return
    setCurrent((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next))
  }
  trackRef.current = track

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    el.innerHTML = toEditorHtml(props.note)
    if (props.autoFocus) el.focus()
    measureRef.current()
    const imgs = [...el.querySelectorAll<HTMLImageElement>('img[data-note-img]')]
    void (async () => {
      for (const img of imgs) {
        const id = img.getAttribute('data-note-img')
        if (!id) continue
        try {
          const blob = await getImage(id)
          if (cancelled || !blob || !img.isConnected) continue
          const url = URL.createObjectURL(blob)
          urls.current.push(url)
          img.src = url
          img.onload = () => measureRef.current()
        } catch {
          // 这张图读不出来就留着占位
        }
      }
    })()
    return () => {
      cancelled = true
      for (const url of urls.current) URL.revokeObjectURL(url)
      urls.current = []
    }
    // 只在换一篇笔记时灌入正文，打字时不能把光标打回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.note.id])

  const sync = () => {
    const el = ref.current
    if (!el) return
    const html = serialize(el)
    onChange.current(html)
    measure()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => measureRef.current())
    }
    const observer = new MutationObserver(schedule)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(el)
    schedule()
    const onCaret = () => trackRef.current()
    document.addEventListener('selectionchange', onCaret)
    return () => {
      observer.disconnect()
      resize.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', onCaret)
    }
  }, [])

  const place = async (el: HTMLDivElement, range: Range | null, file: Blob) => {
    try {
      const blob = await compressImage(file)
      const id = crypto.randomUUID()
      await putImage(id, blob)
      if (!el.isConnected) {
        void deleteImage(id)
        return
      }
      const url = URL.createObjectURL(blob)
      urls.current.push(url)
      el.focus()
      insertImage(el, range, id, url)
      const img = el.querySelector(`img[data-note-img="${id}"]`)
      if (img instanceof HTMLImageElement) img.onload = () => measureRef.current()
      sync()
    } catch {
      useAppStore.getState().setNotice('图片放不下')
    }
  }

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const range = caretRange(el)
    const file = imageFromEvent(event)
    if (file) {
      event.preventDefault()
      void place(el, range, file)
      return
    }
    if (event.clipboardData.getData('text/plain') || event.clipboardData.getData('text/html')) return
    event.preventDefault()
    void (async () => {
      try {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          const type = item.types.find((name) => name.startsWith('image/'))
          if (!type) continue
          await place(el, range, await item.getType(type))
          return
        }
      } catch {
        // 剪贴板里没有图片
      }
    })()
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      <div className="relative flex min-h-full">
        {current && (
          <div
            className="pointer-events-none absolute right-0 left-0 bg-background"
            style={{ top: current.top, height: current.height }}
          />
        )}
        <div className="relative w-10 shrink-0 self-stretch border-r border-border/70" aria-hidden>
          {tops.map((top, index) => (
            <span
              key={index}
              className="absolute right-2 text-sm leading-[22px] text-muted-foreground/60 tabular-nums"
              style={{ top }}
            >
              {index + 1}
            </span>
          ))}
        </div>
        <div className="relative min-h-full min-w-0 flex-1">
          <div
            ref={ref}
            contentEditable
            role="textbox"
            aria-multiline="true"
            suppressContentEditableWarning
            className="min-h-full w-full cursor-text bg-transparent pt-0 pr-2.5 pb-2 pl-2 text-sm leading-[22px] break-words whitespace-pre-wrap text-foreground outline-none [&_img]:my-2 [&_img]:block [&_img]:max-w-full [&_img]:rounded-md [&>:first-child>img]:mt-0 [&_img:first-child]:mt-0"
            onInput={sync}
            onPaste={onPaste}
            onFocus={track}
            onBlur={() => setCurrent(null)}
          />
        </div>
      </div>
    </div>
  )
}

/** 笔记：单击切换，双击改名，正文可换行，截图 Ctrl+V 贴进来。只存在本机。 */
export function NotesTool() {
  const [notes, setNotes] = useState<Note[]>(() => {
    const saved = fillAutoTitles(readNotes())
    return saved.length ? saved : [blankNote('笔记1')]
  })
  const [selectedId, setSelectedId] = useState<string | null>(notes[0]?.id ?? null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [focusId, setFocusId] = useState<string | null>(null)
  const cancelRename = useRef(false)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
  }, [notes])

  const selected = notes.find((note) => note.id === selectedId) ?? null

  const create = () => {
    const note = blankNote(nextAutoTitle(notes))
    setFocusId(note.id)
    setNotes((current) => [...current, note])
    setSelectedId(note.id)
  }

  const patch = (id: string, next: Partial<Note>) => {
    setNotes((current) => current.map((note) => (note.id === id ? { ...note, ...next } : note)))
  }

  const patchBody = (id: string, html: string) => {
    setNotes((current) =>
      current.map((note) => {
        if (note.id !== id) return note
        if (note.rich && note.body === html) return note
        if (note.rich) {
          const nextIds = new Set(imageIds(html))
          for (const imgId of imageIds(note.body)) {
            if (!nextIds.has(imgId)) void deleteImage(imgId)
          }
        }
        return { ...note, body: html, rich: true }
      })
    )
  }

  const remove = (id: string) => {
    const note = notes.find((item) => item.id === id)
    if (note?.rich) dropImages(note.body)
    const next = notes.filter((item) => item.id !== id)
    if (next.length === 0) {
      const fresh = blankNote('笔记1')
      setNotes([fresh])
      setSelectedId(fresh.id)
      setFocusId(fresh.id)
    } else {
      setNotes(next)
      if (selectedId === id) setSelectedId(next[0]?.id ?? null)
    }
    if (renamingId === id) setRenamingId(null)
  }

  const startRename = (note: Note) => {
    cancelRename.current = false
    setSelectedId(note.id)
    setDraft(note.title)
    setRenamingId(note.id)
  }

  const commitRename = () => {
    if (renamingId) patch(renamingId, { title: oneLine(draft).trim() })
    setRenamingId(null)
  }

  const listRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const suppressClick = useRef(false)
  const prevTop = useRef(new Map<string, number>())
  const dragStart = useRef({ pos: 0, layout: 0, grab: 0, size: 0 })
  const pointerY = useRef(0)
  const notesRef = useRef(notes)
  notesRef.current = notes

  const noteRow = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(id)}"]`)

  const followPointer = (id: string) => {
    const list = listRef.current
    const el = noteRow(id)
    if (!list || !el) return
    const offset = pointerY.current - dragStart.current.pos - (el.offsetTop - dragStart.current.layout)
    const items = list.querySelectorAll<HTMLElement>('[data-note-id]')
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return setDragOffset(offset)
    const min = first.offsetTop - el.offsetTop
    const max = last.offsetTop + last.offsetHeight - el.offsetHeight - el.offsetTop
    setDragOffset(Math.min(max, Math.max(min, offset)))
  }

  const dropOrder = (clientY: number, id: string) => {
    const list = listRef.current
    if (!list) return null
    const ids = notesRef.current.map((note) => note.id)
    const raw = clientY - list.getBoundingClientRect().top + list.scrollTop - dragStart.current.grab
    const items = list.querySelectorAll<HTMLElement>('[data-note-id]')
    const first = items[0]
    const last = items[items.length - 1]
    const start =
      first && last
        ? Math.min(last.offsetTop + last.offsetHeight - dragStart.current.size, Math.max(first.offsetTop, raw))
        : raw
    return moveTo(ids, id, dropIndex(list, 'data-note-id', 'y', start, start + dragStart.current.size, id, ids))
  }

  const reorder = (ids: string[]) => {
    const byId = new Map(notesRef.current.map((note) => [note.id, note]))
    const next: Note[] = []
    for (const id of ids) {
      const note = byId.get(id)
      if (note) next.push(note)
    }
    if (next.length !== notesRef.current.length) return
    notesRef.current = next
    setNotes(next)
  }

  const startDrag = (event: ReactPointerEvent, id: string) => {
    if (event.target instanceof HTMLElement && event.target.closest('input, button[aria-label="删除"]')) return
    setSelectedId(id)
    startPointerDrag({
      event,
      axis: 'y',
      onActivate: () => {
        const list = listRef.current
        const el = noteRow(id)
        const pointer = list ? event.clientY - list.getBoundingClientRect().top + list.scrollTop : 0
        dragStart.current = {
          pos: event.clientY,
          layout: el?.offsetTop ?? 0,
          grab: pointer - (el?.offsetTop ?? 0),
          size: el?.offsetHeight ?? 0
        }
        setDragId(id)
        setDragOffset(0)
      },
      onMove: (y) => {
        pointerY.current = y
        const next = dropOrder(y, id)
        if (next && listRef.current) {
          capturePositions(listRef.current, 'data-note-id', 'y', prevTop.current)
          reorder(next)
        }
        followPointer(id)
      },
      onEnd: () => {
        suppressClick.current = true
        prevTop.current.clear()
        setDragId(null)
        setDragOffset(0)
      }
    })
  }

  useFlipSlide(dragId !== null, listRef, 'data-note-id', 'y', dragId, prevTop, [notes, dragId])
  useLayoutEffect(() => {
    if (dragId) followPointer(dragId)
    // 跟手位移要等这次重排画完再算，算早了用的是旧布局位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, dragId])

  const eatClick = () => {
    if (!suppressClick.current) return false
    suppressClick.current = false
    return true
  }

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col">
      <aside className="absolute inset-y-0 left-[max(0px,calc((100%-48rem)/2-0.75rem-11rem))] flex w-[min(11rem,max(0px,calc((100%-48rem)/2-0.75rem)))] flex-col overflow-hidden">
        <div
          ref={listRef}
          className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
          onDoubleClick={(event) => {
            const target = event.target
            if (!(target instanceof HTMLElement) || target.closest('[data-note-row]')) return
            create()
          }}
        >
          {notes.map((note) => {
            const on = note.id === selected?.id
            const dragging = dragId === note.id
            return (
              <div
                key={note.id}
                data-note-row
                data-note-id={note.id}
                className={cn(
                  'flex h-8 w-full items-center rounded-md pr-0.5 text-[13px] font-medium text-muted-foreground',
                  on ? 'bg-accent' : 'hover:bg-accent',
                  dragging && 'relative z-10'
                )}
                style={dragging ? { transform: `translateY(${dragOffset}px)` } : undefined}
                onPointerDown={(event) => startDrag(event, note.id)}
              >
                {renamingId === note.id ? (
                  <Input
                    autoFocus
                    value={draft}
                    placeholder="无标题"
                    aria-label="重命名"
                    className="h-8 min-w-0 flex-1 px-2 text-[13px] text-foreground"
                    onChange={(event) => setDraft(oneLine(event.target.value))}
                    onFocus={(event) => {
                      const end = event.currentTarget.value.length
                      event.currentTarget.setSelectionRange(end, end)
                    }}
                    onBlur={() => {
                      if (cancelRename.current) {
                        cancelRename.current = false
                        return
                      }
                      commitRename()
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.key === 'Process') return
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        cancelRename.current = true
                        setRenamingId(null)
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="h-8 min-w-0 flex-1 cursor-pointer truncate px-2 text-left"
                    onClick={() => {
                      if (eatClick()) return
                      setSelectedId(note.id)
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      startRename(note)
                    }}
                  >
                    {label(note)}
                  </button>
                )}
                <button
                  type="button"
                  aria-label="删除"
                  className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
                  onClick={() => {
                    if (eatClick()) return
                    remove(note.id)
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
          <div className="min-h-8 flex-1" />
        </div>
      </aside>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden rounded-lg border border-border bg-muted">
        {selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            autoFocus={focusId === selected.id}
            onChange={(html) => patchBody(selected.id, html)}
          />
        ) : (
          <div className="min-h-0 flex-1" />
        )}
      </div>
    </div>
  )
}
