/**
 * 右键「复制命令」：把选中的代码块整理成粘贴就能跑的命令。
 * - 去掉整块共同的缩进（AI 回复里代码块统一缩进了几格），行与行之间的相对缩进保留，
 *   heredoc 里的 Python、结尾的 PY 才对得上
 * - 行尾是 \ 的续行保留换行，照常是多行命令
 * - 程序（Kimi 这类）按窗口宽度自己折开的长命令接回一行：
 *   上一行剩下的空间放不下下一行开头那个词，说明是它折的；放得下就是本来就换的行，保留
 */

/** 选区里的一行（终端自己软折的已经拼好）。used 是它最后一个屏幕行实际占到第几格 */
export interface CopiedRow {
  text: string
  used: number
}

/** 程序折行时可能给右边留几格空，判断时宽限这么多 */
const MARGIN = 2

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

/** 一段文字在终端里占几格：中文、全角符号两格，其余一格 */
function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1
  return width
}

const firstWord = (text: string) => text.split(/\s/, 1)[0]

export function formatCommand(rows: CopiedRow[], cols: number): string {
  // 先把折开的行接回去。indent 是这条第一行的缩进，null 表示量不准（不参与算共同缩进）
  const lines: { indent: number | null; text: string }[] = []
  let freshLine = false
  rows.forEach((row, index) => {
    const raw = row.text.trimEnd()
    const text = raw.trimStart()
    const next = rows[index + 1]?.text.trim() ?? ''
    // 一个没法折的长串（比半个窗口还长、没有中文）在缩进后面放不下时，程序会把缩进单独留成一行空白，
    // 串放到下一行。这行空白不是原文的空行（\ 续行后面跟空行就断了），丢掉；下一行是新的一行，不往上接。
    // 中文能逐字折，不会这样，所以开头带中文的不算
    const head = firstWord(next)
    if (text === '' && head !== '' && !WIDE.test(head) && cellWidth(head) > cols / 2) {
      freshLine = true
      return
    }
    const prev = lines[lines.length - 1]
    const prevRow = rows[index - 1]
    if (!freshLine && prev && prevRow && prev.text !== '' && text !== '' && !prev.text.endsWith('\\')) {
      if (cellWidth(firstWord(text)) + 1 + MARGIN > cols - prevRow.used) {
        prev.text += joiner(prevRow, prev.text, text, cols) + text
        return
      }
    }
    lines.push({ indent: freshLine ? null : cellWidth(raw.slice(0, raw.length - text.length)), text })
    freshLine = false
  })

  // 共同缩进从第二行起算：选区常从第一行的缩进中间、或第一个字开始，第一行量不准
  const measured = lines.slice(1).filter((line) => line.text !== '' && line.indent !== null)
  const common = measured.length > 0 ? Math.min(...measured.map((line) => line.indent!)) : 0
  const out = lines.map((line, index) =>
    line.text === '' || index === 0 || line.indent === null
      ? line.text
      : ' '.repeat(Math.max(0, line.indent - common)) + line.text
  )

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  while (out.length > 0 && out[0] === '') out.shift()
  return out.join('\n')
}

/** 接回去时中间补不补空格 */
function joiner(prevRow: CopiedRow, prevText: string, text: string, cols: number): string {
  const remaining = cols - prevRow.used
  // 中文能在任意两个字中间折，也能和英文紧挨着折，那样原来没有空格。但只有下一个字确实放不下才会这样折：
  // 剩下的地方还够放一个空格加这个字，说明折在原来的空格上，要补回去
  const head = [...text][0] ?? ''
  if (WIDE.test(head)) return remaining >= cellWidth(head) + 1 + MARGIN ? ' ' : ''
  // 中文后面紧跟英文词：分不清原来有没有空格，按紧挨着算
  if (WIDE.test([...prevText].at(-1) ?? '')) return ''
  // 一整行只有一个词、没有空格还写满了：是比整行还长的串（长网址、base64）从中间截断的。
  // 带中文的不算：程序能在中文处折，用不着硬截，这一行是在后面的空格处按词折的
  const row = prevRow.text.trim()
  if (!/\s/.test(row) && !WIDE.test(row) && remaining <= MARGIN) return ''
  // 其余是按词折的，折掉的是一个空格，补回去
  return ' '
}
