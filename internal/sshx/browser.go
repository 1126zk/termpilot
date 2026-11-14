package sshx

import (
	"fmt"
	"strings"
	"sync/atomic"
)

// 云浏览器是服务器上一个固定名字的容器，和 nginx/caddy 一样走 docker，
// 不进网站管理。镜像自己把宿主机 9222 转到 Chrome，预览和 Agent 都从这里进。

const (
	browserContainer = "termpilot-browser"
	browserImage     = "chromedp/headless-shell"
	// browserCDPPort 宿主机上的调试端口。镜像用 socat 听这里，再转到容器里 Chrome 的 9223。
	// 不要把这个端口写进 docker run，否则 Chrome 会抢走 [::1]:9222，socat 连不上 9223。
	browserCDPPort = 9222
)

// browserStatusScript 先分清 Docker 在不在、引擎开没开，再看容器。
// 容器不存在时 inspect 失败，状态段是空的，不能和「没装 Docker」混在一次失败里。
const browserStatusScript = `
echo '#TP-DOCKER#'
command -v docker >/dev/null 2>&1 && echo yes || echo no
echo '#TP-RUNNING#'
errf=$(mktemp)
if docker info >/dev/null 2>"$errf"; then echo yes; else echo no; fi
echo '#TP-ERR#'
cat "$errf" 2>/dev/null
rm -f "$errf"
echo '#TP-STATE#'
docker inspect -f '{{.State.Status}}' termpilot-browser 2>/dev/null
echo '#TP-END#'
`

// browserPull 一次正在进行的镜像拉取，暂停时关掉 cancel 并打上标记。
type browserPull struct {
	cancel chan struct{}
	paused atomic.Bool
}

// errBrowserPaused 用户点了暂停。不能当成安装失败。
var errBrowserPaused = fmt.Errorf("已暂停")

// browserStopPullScript 停掉这次镜像拉取。script 会新开进程组，只关 SSH 通道杀不掉 docker pull。
const browserStopPullScript = `
ps -eo pid=,args= | while read -r pid args; do
  case "$args" in
    *'docker pull chromedp/headless-shell'*)
      kill "$pid" 2>/dev/null || true
      ;;
  esac
done
exit 0
`

// browserClearCacheScript 只删没下完的层。装好的镜像、容器和 ~/.termpilot 都不动。
const browserClearCacheScript = `
set -e
for d in \
  /var/lib/containerd/io.containerd.content.v1.content/ingest \
  /var/lib/docker/tmp \
  "$HOME/.local/share/docker/tmp"
do
  [ -d "$d" ] || continue
  find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
done
`

// browserWaitPort 容器起来之后等调试页真的有响应。只看到 9222 在听不够，那可能是 socat 在空转。
const browserWaitPort = `
cdp_up() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf --noproxy '*' --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn | grep -Eq ':(9222)([^0-9]|$)' && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn | grep -Eq ':(9222)([^0-9]|$)' && return 0
    return 1
  fi
  (echo >/dev/tcp/127.0.0.1/9222) >/dev/null 2>&1 && return 0
  return 1
}
i=0
while [ "$i" -lt 15 ]; do
  if cdp_up; then exit 0; fi
  i=$((i + 1))
  sleep 1
done
echo '浏览器已启动，但调试端口没有响应' >&2
exit 1
`

// browserInstallScript 没装就拉镜像并创建容器；容器已在则改为启动。
// 字体目录不存在时不挂，避免 Docker 在宿主机上建出空目录。
// 调试端口交给镜像：它用 socat 把 9222 转到 Chrome 的 9223。
const browserInstallScript = `
set -e
if ! command -v docker >/dev/null 2>&1; then
  echo '这台服务器没有安装 Docker' >&2
  exit 1
fi
mkdir -p "$HOME/.termpilot/browser"
if docker inspect termpilot-browser >/dev/null 2>&1; then
  docker start termpilot-browser
else
  if ! docker image inspect chromedp/headless-shell >/dev/null 2>&1; then
    # 管道里 docker 不刷百分比。script 分配一个伪终端，进度才会用回车符刷新。
    if script -q -f -e -c "true" /dev/null >/dev/null 2>&1; then
      script -q -f -e -c "timeout 180 docker pull chromedp/headless-shell" /dev/null
    else
      timeout 180 docker pull chromedp/headless-shell
    fi
  fi
  run_browser() {
    docker run -d \
      --name termpilot-browser \
      --restart unless-stopped \
      --network host \
      --shm-size=1g \
      -v "$HOME/.termpilot/browser:/data" \
      "$@" \
      chromedp/headless-shell \
      --user-data-dir=/data \
      --no-sandbox \
      --disable-gpu \
      --use-gl=angle \
      --use-angle=swiftshader
  }
  if [ -d /usr/share/fonts ]; then
    run_browser -v /usr/share/fonts:/usr/share/fonts:ro
  else
    run_browser
  fi
fi
` + browserWaitPort

const browserStartScript = `
set -e
docker start termpilot-browser
` + browserWaitPort

// parseBrowserInfo 把探测脚本的分段输出收成状态。Docker 没在跑时不读容器状态。
func parseBrowserInfo(stdout string) *BrowserInfo {
	sec := splitSections(stdout)
	info := &BrowserInfo{
		DockerAvailable: strings.TrimSpace(sec["DOCKER"]) == "yes",
		DockerRunning:   strings.TrimSpace(sec["RUNNING"]) == "yes",
	}
	info.NeedSudo = info.DockerAvailable && !info.DockerRunning && dockerNeedsSudo(sec["ERR"])
	if info.DockerRunning {
		info.State = strings.TrimSpace(sec["STATE"])
	}
	return info
}

// CollectBrowser 探测云浏览器容器。只区分 Docker 和容器，不启动任何东西。
func (s *ExecService) CollectBrowser(sessionID string) (*BrowserInfo, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: browserStatusScript, TimeoutMs: 10000})
	if err != nil {
		return nil, err
	}
	if res.TimedOut {
		return nil, fmt.Errorf("检查云浏览器超时")
	}
	return parseBrowserInfo(res.Stdout), nil
}

func (s *ExecService) beginBrowserPull(sessionID string) *browserPull {
	p := &browserPull{cancel: make(chan struct{})}
	s.mu.Lock()
	s.pulls[sessionID] = p
	s.mu.Unlock()
	return p
}

func (s *ExecService) endBrowserPull(sessionID string, p *browserPull) {
	s.mu.Lock()
	if s.pulls[sessionID] == p {
		delete(s.pulls, sessionID)
	}
	s.mu.Unlock()
}

// PauseBrowserInstall 停掉正在进行的镜像拉取，已下到的部分留着。
func (s *ExecService) PauseBrowserInstall(sessionID string) error {
	s.mu.Lock()
	p := s.pulls[sessionID]
	if p == nil || p.paused.Load() {
		s.mu.Unlock()
		return fmt.Errorf("没有正在进行的下载")
	}
	p.paused.Store(true)
	cancel := p.cancel
	s.mu.Unlock()
	select {
	case <-cancel:
	default:
		close(cancel)
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: browserStopPullScript, TimeoutMs: 15000})
	if err != nil {
		return err
	}
	if res.TimedOut {
		return fmt.Errorf("暂停下载超时")
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("暂停下载失败（退出码 %d）：%s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

// ClearBrowserPullCache 删掉没下完的镜像层。正在下载时要先暂停。
func (s *ExecService) ClearBrowserPullCache(sessionID string) error {
	s.mu.Lock()
	p := s.pulls[sessionID]
	busy := p != nil && !p.paused.Load()
	s.mu.Unlock()
	if busy {
		return fmt.Errorf("请先暂停下载")
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: browserClearCacheScript, TimeoutMs: 30000})
	if err != nil {
		return err
	}
	if res.TimedOut {
		return fmt.Errorf("清空缓存超时")
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		msg := briefCommandOutput(res.Stderr)
		if msg == "" {
			msg = briefCommandOutput(res.Stdout)
		}
		if msg == "" {
			return fmt.Errorf("清空缓存失败（退出码 %d）", *res.ExitCode)
		}
		return fmt.Errorf("清空缓存失败（退出码 %d）：%s", *res.ExitCode, msg)
	}
	return nil
}

// BrowserInstall 一键安装并启动云浏览器。onLine 非空时把拉取和启动的输出逐行送出去。
func (s *ExecService) BrowserInstall(sessionID string, onLine func(string)) error {
	pull := s.beginBrowserPull(sessionID)
	defer s.endBrowserPull(sessionID, pull)
	res, err := s.Exec(sessionID, ExecOptions{
		Command:   browserInstallScript,
		TimeoutMs: 300000,
		OnLine:    onLine,
		Cancel:    pull.cancel,
	})
	if pull.paused.Load() || (res != nil && res.Canceled) {
		return errBrowserPaused
	}
	if err != nil {
		return err
	}
	if res.TimedOut {
		return fmt.Errorf("安装云浏览器超时（5 分钟），镜像可能还在后台拉取，稍后再试")
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		// 124 是 timeout 杀掉拉取的退出码。原始输出是整段进度条，不能拿去当提示。
		if *res.ExitCode == 124 {
			return fmt.Errorf("拉取镜像超时")
		}
		msg := briefCommandOutput(res.Stderr)
		if msg == "" {
			msg = briefCommandOutput(res.Stdout)
		}
		if msg == "" {
			return fmt.Errorf("安装云浏览器失败（退出码 %d）", *res.ExitCode)
		}
		return fmt.Errorf("安装云浏览器失败（退出码 %d）：%s", *res.ExitCode, msg)
	}
	return nil
}

// BrowserService 启动或关闭已安装的云浏览器。op 只认 start / stop。
func (s *ExecService) BrowserService(sessionID, op string) error {
	cmd := ""
	timeoutMs := 30000
	switch op {
	case "start":
		cmd = browserStartScript
	case "stop":
		cmd = "docker stop " + browserContainer
	default:
		return fmt.Errorf("不支持的操作：%q", op)
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: cmd, TimeoutMs: timeoutMs})
	if err != nil {
		return err
	}
	if res.TimedOut {
		return fmt.Errorf("云浏览器%s超时", browserOpLabel(op))
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("云浏览器%s失败（退出码 %d）：%s", browserOpLabel(op), *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

func browserOpLabel(op string) string {
	if op == "start" {
		return "启动"
	}
	return "关闭"
}
