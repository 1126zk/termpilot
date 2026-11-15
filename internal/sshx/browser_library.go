package sshx

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// BrowserBookmarkPath 收藏栏存在浏览器用户目录里，和页面数据一起留下，Chrome 不读这个文件。
const BrowserBookmarkPath = "$HOME/.termpilot/browser/termpilot-bookmarks.json"

// BrowserBookmark 收藏栏上的一条。
type BrowserBookmark struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

// BrowserVisit 一条访问记录。VisitedAt 是 Unix 毫秒。
type BrowserVisit struct {
	URL       string `json:"url"`
	Title     string `json:"title"`
	VisitedAt int64  `json:"visitedAt"`
}

const bookmarkLimit = 200

// ParseBookmarks 读收藏文件。空文件是空列表。坏掉的单条跳过，整份不是 JSON 才报错。
func ParseBookmarks(raw string) ([]BrowserBookmark, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []BrowserBookmark{}, nil
	}
	var items []BrowserBookmark
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil, fmt.Errorf("收藏读不出来")
	}
	out := make([]BrowserBookmark, 0, len(items))
	for _, item := range items {
		pageURL, err := cleanBookmarkURL(item.URL)
		if err != nil {
			continue
		}
		out = append(out, BrowserBookmark{URL: pageURL, Title: cleanBookmarkTitle(item.Title, pageURL)})
	}
	return out, nil
}

// MarshalBookmarks 写成收藏文件。
func MarshalBookmarks(items []BrowserBookmark) (string, error) {
	if items == nil {
		items = []BrowserBookmark{}
	}
	buf, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return "", err
	}
	return string(buf) + "\n", nil
}

// AddBookmark 把当前页放进收藏栏。同一个地址已在栏里时只更新标题。
func AddBookmark(items []BrowserBookmark, pageURL, title string) ([]BrowserBookmark, error) {
	clean, err := cleanBookmarkURL(pageURL)
	if err != nil {
		return nil, err
	}
	name := cleanBookmarkTitle(title, clean)
	for i, item := range items {
		if item.URL == clean {
			items[i].Title = name
			return items, nil
		}
	}
	if len(items) >= bookmarkLimit {
		return nil, fmt.Errorf("收藏栏满了")
	}
	return append(items, BrowserBookmark{URL: clean, Title: name}), nil
}

// RemoveBookmark 按地址从收藏栏拿走。没有这条也照常返回。
func RemoveBookmark(items []BrowserBookmark, pageURL string) []BrowserBookmark {
	clean := strings.TrimSpace(pageURL)
	out := make([]BrowserBookmark, 0, len(items))
	for _, item := range items {
		if item.URL == clean {
			continue
		}
		out = append(out, item)
	}
	return out
}

func cleanBookmarkURL(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	u, err := url.Parse(text)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("这个地址不能收藏")
	}
	return text, nil
}

func cleanBookmarkTitle(title, pageURL string) string {
	text := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(title, "\r", " "), "\n", " "))
	if text == "" || text == "about:blank" {
		text = pageURL
	}
	runes := []rune(text)
	if len(runes) > 120 {
		text = string(runes[:120])
	}
	return text
}

func httpURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https")
}

// browserHistoryScript 把 Chrome 的 History 库拷出来再查。浏览器开着时原文件是锁住的。
const browserHistoryScript = `
hist="$HOME/.termpilot/browser/Default/History"
if [ ! -f "$hist" ]; then
  printf '%s\n' '[]'
  exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$hist" "$tmp/History" || exit 1
if [ -f "$hist-wal" ]; then cp "$hist-wal" "$tmp/History-wal" || exit 1; fi
if [ -f "$hist-shm" ]; then cp "$hist-shm" "$tmp/History-shm" || exit 1; fi
sql="SELECT url, IFNULL(title, '') AS title, CASE WHEN last_visit_time > 11644473600000000 THEN (last_visit_time - 11644473600000000) / 1000 ELSE 0 END AS visitedAt FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT 30"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$tmp/History" "$sql" <<'PY'
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
try:
    rows = con.execute(sys.argv[2]).fetchall()
finally:
    con.close()
out = [{"url": row[0] or "", "title": row[1] or "", "visitedAt": int(row[2] or 0)} for row in rows]
sys.stdout.write(json.dumps(out))
PY
  exit $?
fi
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 -json "$tmp/History" "$sql"
  exit $?
fi
echo '读不了历史记录' >&2
exit 1
`

var bookmarkReadScript = "f=\"" + BrowserBookmarkPath + "\"\n" + `
if [ ! -f "$f" ]; then
  printf '%s\n' '[]'
  exit 0
fi
cat "$f"
`

// LoadBookmarks 读收藏栏。还没有文件时是空列表。
func (s *ExecService) LoadBookmarks(sessionID string) ([]BrowserBookmark, error) {
	res, err := s.execText(sessionID, bookmarkReadScript, 10000, "收藏读不出来")
	if err != nil {
		return nil, err
	}
	return ParseBookmarks(res)
}

// SaveBookmarks 把收藏栏写回浏览器用户目录。
func (s *ExecService) SaveBookmarks(sessionID string, items []BrowserBookmark) error {
	text, err := MarshalBookmarks(items)
	if err != nil {
		return err
	}
	script := "mkdir -p \"$HOME/.termpilot/browser\"\ncat > \"" + BrowserBookmarkPath + "\" <<'TERMPILOT_BOOKMARK_FILE_END'\n" + text + "TERMPILOT_BOOKMARK_FILE_END\n"
	_, err = s.execText(sessionID, script, 10000, "收藏没有写上")
	return err
}

func (s *ExecService) execText(sessionID, script string, timeoutMs int, fail string) (string, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: strings.ReplaceAll(script, "\r\n", "\n"), TimeoutMs: timeoutMs})
	if err != nil {
		return "", fmt.Errorf("%s", FriendlyError(err))
	}
	if res.TimedOut || (res.ExitCode != nil && *res.ExitCode != 0) {
		msg := strings.TrimSpace(res.Stderr)
		if res.TimedOut || msg == "" || strings.Contains(msg, "\n") || len([]rune(msg)) > 80 {
			msg = fail
		}
		return "", fmt.Errorf("%s", msg)
	}
	return res.Stdout, nil
}

// BrowserHistory 读云浏览器已经访问过的页面，新的在前。
func (s *ExecService) BrowserHistory(sessionID string) ([]BrowserVisit, error) {
	stdout, err := s.execText(sessionID, browserHistoryScript, 15000, "读不了历史记录")
	if err != nil {
		return nil, err
	}
	visits, err := parseBrowserHistory(stdout)
	if err != nil {
		return nil, err
	}
	return visits, nil
}

const browserHistoryClearScript = `
hist="$HOME/.termpilot/browser/Default/History"
if [ ! -f "$hist" ]; then
  exit 0
fi
if command -v python3 >/dev/null 2>&1; then
  python3 - "$hist" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=5)
try:
    con.execute("PRAGMA busy_timeout=5000")
    for name in ("visits", "keyword_search_terms", "urls"):
        try:
            con.execute("DELETE FROM " + name)
        except sqlite3.OperationalError as err:
            if "no such table" not in str(err):
                raise
    con.commit()
finally:
    con.close()
PY
  exit $?
fi
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$hist" ".timeout 5000" "DELETE FROM visits; DELETE FROM urls;"
  exit $?
fi
echo '删不了历史记录' >&2
exit 1
`

// ClearBrowserHistory 清掉云浏览器已经记下的访问记录。
func (s *ExecService) ClearBrowserHistory(sessionID string) error {
	_, err := s.execText(sessionID, browserHistoryClearScript, 15000, "删不了历史记录")
	return err
}

func parseBrowserHistory(raw string) ([]BrowserVisit, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []BrowserVisit{}, nil
	}
	var rows []struct {
		URL       string  `json:"url"`
		Title     string  `json:"title"`
		VisitedAt float64 `json:"visitedAt"`
	}
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil, fmt.Errorf("读不了历史记录")
	}
	out := make([]BrowserVisit, 0, len(rows))
	for _, row := range rows {
		if !httpURL(row.URL) {
			continue
		}
		title := strings.TrimSpace(row.Title)
		if title == "" {
			title = row.URL
		}
		out = append(out, BrowserVisit{URL: row.URL, Title: title, VisitedAt: int64(row.VisitedAt)})
	}
	return out, nil
}
