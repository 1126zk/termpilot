package sftpx

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// 传输与取消，对应 TS SftpService 的 put/get/uploadPaths/download/downloadDir/
// cancelTransfer/streamTransfer/beginGroup/endGroup 及树遍历辅助。

// ErrCancelled 取消语义（TS 里按错误消息 === '已取消' 判断，这里用 errors.Is）。
var ErrCancelled = errors.New("已取消")

// errInterrupted 对应 TS 的「传输中断」：流提前结束，字节数不够。
var errInterrupted = errors.New("传输中断")

// chunkSize 对应 TS CHUNK。
const chunkSize = 32 * 1024

// transferGroup 文件夹传输的聚合进度：整棵树共用一条事件，Transferred 跨文件累计。
type transferGroup struct {
	id        string
	sessionID string
	direction string
	name      string
	total     int64

	transferred atomic.Int64
	cancelled   atomic.Bool

	mu    sync.Mutex
	abort func() // 取消时毁掉正在传的那个文件
}

func (g *transferGroup) setAbort(fn func()) {
	g.mu.Lock()
	g.abort = fn
	cancelled := g.cancelled.Load()
	g.mu.Unlock()
	// 取消可能先于本文件的注册到达（beginGroup 到 streamTransfer 之间的窗口），
	// 此时立刻毁掉这条传输，效果和遍历方在下一个文件前检查 cancelled 一致。
	if cancelled {
		fn()
	}
}

// transferOptions 一条流传输的参数。
type transferOptions struct {
	sessionID string
	direction string
	name      string
	total     int64
	// openSource/openDest 由调用方接管（上传 = 本地读 + 远程写，下载反之）。
	openSource func() (io.ReadCloser, error)
	openDest   func() (io.WriteCloser, error)
	// cleanupPartial 失败/取消时删掉没传完的残留（下载删本地，上传删远程）。
	cleanupPartial func()
	group          *transferGroup
}

// Put 对应 TS put：上传单个本地文件。
func (s *Service) Put(sessionID, localPath, remotePath string) error {
	if !filepath.IsAbs(localPath) {
		return errors.New("本地路径需要是绝对路径")
	}
	info, err := os.Stat(localPath)
	if err != nil {
		return errors.New("本地文件不存在")
	}
	total := info.Size()
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(remotePath), func(target string) error {
			return s.streamTransfer(transferOptions{
				sessionID:  sessionID,
				direction:  DirectionUp,
				name:       remoteBase(target),
				total:      total,
				openSource: func() (io.ReadCloser, error) { return os.Open(localPath) },
				openDest:   func() (io.WriteCloser, error) { return conn.client.Create(target) },
				cleanupPartial: func() {
					_ = conn.client.Remove(target)
				},
			})
		})
	})
}

// Get 对应 TS get：下载单个远程文件到本地路径。
func (s *Service) Get(sessionID, remotePath, localPath string) error {
	if !filepath.IsAbs(localPath) {
		return errors.New("本地路径需要是绝对路径")
	}
	if info, err := os.Stat(filepath.Dir(localPath)); err != nil || !info.IsDir() {
		return errors.New("本地目录不存在")
	}
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(remotePath), func(target string) error {
			total, err := statSize(conn.client, target)
			if err != nil {
				return err
			}
			return s.streamTransfer(transferOptions{
				sessionID:  sessionID,
				direction:  DirectionDown,
				name:       remoteBase(target),
				total:      total,
				openSource: func() (io.ReadCloser, error) { return conn.client.Open(target) },
				openDest:   func() (io.WriteCloser, error) { return os.Create(localPath) },
				cleanupPartial: func() {
					_ = os.Remove(localPath)
				},
			})
		})
	})
}

// UploadPaths 对应 TS uploadPaths：按路径批量上传，文件按文件名放进 dir，
// 目录整棵递归上传。单个文件被取消不影响剩下的。返回成功上传的条目数。
// （TS 里的文件选择对话框由上层做，这里只接路径。）
func (s *Service) UploadPaths(sessionID, dir string, localPaths []string) (int, error) {
	conn, err := s.sftpOf(sessionID)
	if err != nil {
		return 0, present(err)
	}
	done := 0
	for _, local := range localPaths {
		info, err := os.Stat(local)
		if err != nil {
			continue
		}
		remote := remoteJoin(dirOrDot(normalizeRemotePath(dir)), filepath.Base(local))
		if info.IsDir() {
			total, err := localTreeSize(local)
			if err != nil {
				return done, present(err)
			}
			group := s.beginGroup(sessionID, DirectionUp, filepath.Base(local), total)
			n, err := s.uploadTree(conn, local, remote, group)
			if err != nil {
				s.endGroup(group, err.Error())
				if !errors.Is(err, ErrCancelled) {
					return done, present(err)
				}
				continue
			}
			done += n
			s.endGroup(group, "")
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		ok, err := s.uploadFile(conn, sessionID, local, remote, nil)
		if err != nil {
			return done, present(err)
		}
		if ok {
			done++
		}
	}
	return done, nil
}

// Download 对应 TS download：目录拒绝，文件下载到 localPath（保存对话框由上层做）。
func (s *Service) Download(sessionID string, file RemoteFile, localPath string) error {
	if file.Kind == KindDir {
		return errors.New("先进入目录再下载里面的文件")
	}
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(file.Path), func(target string) error {
			total, err := statSize(conn.client, target)
			if err != nil {
				return err
			}
			return s.streamTransfer(transferOptions{
				sessionID:  sessionID,
				direction:  DirectionDown,
				name:       file.Name,
				total:      total,
				openSource: func() (io.ReadCloser, error) { return conn.client.Open(target) },
				openDest:   func() (io.WriteCloser, error) { return os.Create(localPath) },
				cleanupPartial: func() {
					_ = os.Remove(localPath)
				},
			})
		})
	})
}

// DownloadDir 对应 TS downloadDir：整棵目录下载到 parentDir/<file.Name>。
func (s *Service) DownloadDir(sessionID string, file RemoteFile, parentDir string) error {
	if file.Kind != KindDir {
		return errors.New("只能下载目录")
	}
	localDir := filepath.Join(parentDir, file.Name)
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return err
	}
	return s.run(sessionID, func(conn *liveConn) error {
		return conn.using(normalizeRemotePath(file.Path), func(target string) error {
			total, err := remoteTreeSize(conn, target)
			if err != nil {
				return err
			}
			group := s.beginGroup(sessionID, DirectionDown, file.Name, total)
			if err := s.downloadTree(conn, target, localDir, group); err != nil {
				s.endGroup(group, err.Error())
				return err
			}
			s.endGroup(group, "")
			return nil
		})
	})
}

// CancelTransfer 取消一条进行中的传输。不在列表里（已完成）就当没发生。
func (s *Service) CancelTransfer(id string) {
	s.mu.Lock()
	cancel := s.active[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// uploadFile 对应 TS uploadFile。聚合传输里取消要抛出去让整棵树停下；
// 单文件被取消返回 (false, nil)。
func (s *Service) uploadFile(conn *liveConn, sessionID, local, remote string, group *transferGroup) (bool, error) {
	info, err := os.Stat(local)
	if err != nil {
		return false, err
	}
	total := info.Size()
	err = conn.using(remote, func(target string) error {
		return s.streamTransfer(transferOptions{
			sessionID:  sessionID,
			direction:  DirectionUp,
			name:       remoteBase(target),
			total:      total,
			group:      group,
			openSource: func() (io.ReadCloser, error) { return os.Open(local) },
			openDest:   func() (io.WriteCloser, error) { return conn.client.Create(target) },
			cleanupPartial: func() {
				_ = conn.client.Remove(target)
			},
		})
	})
	if err != nil {
		if group != nil {
			return false, err
		}
		if errors.Is(err, ErrCancelled) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// uploadTree 对应 TS uploadTree：目录已存在时 mkdir 报错属正常，接着往里传。
func (s *Service) uploadTree(conn *liveConn, localDir, remoteDir string, group *transferGroup) (int, error) {
	_ = conn.client.Mkdir(remoteDir)
	done := 0
	items, err := os.ReadDir(localDir)
	if err != nil {
		return done, err
	}
	for _, item := range items {
		if group.cancelled.Load() {
			return done, ErrCancelled
		}
		local := filepath.Join(localDir, item.Name())
		remote := remoteJoin(remoteDir, item.Name())
		if item.IsDir() {
			n, err := s.uploadTree(conn, local, remote, group)
			done += n
			if err != nil {
				return done, err
			}
			continue
		}
		info, err := item.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		ok, err := s.uploadFile(conn, group.sessionID, local, remote, group)
		if err != nil {
			return done, err
		}
		if ok {
			done++
		}
	}
	return done, nil
}

// downloadTree 对应 TS downloadTree。
func (s *Service) downloadTree(conn *liveConn, remoteDir, localDir string, group *transferGroup) error {
	entries, err := readdir(conn.client, remoteDir)
	if err != nil {
		return err
	}
	for _, item := range entries {
		if group.cancelled.Load() {
			return ErrCancelled
		}
		local := filepath.Join(localDir, item.Name)
		if item.Kind == KindDir {
			if err := os.MkdirAll(local, 0o755); err != nil {
				return err
			}
			if err := s.downloadTree(conn, item.Path, local, group); err != nil {
				return err
			}
			continue
		}
		if item.Kind != KindFile {
			continue
		}
		total, err := statSize(conn.client, item.Path)
		if err != nil {
			return err
		}
		if err := s.streamTransfer(transferOptions{
			sessionID:  group.sessionID,
			direction:  DirectionDown,
			name:       item.Name,
			total:      total,
			group:      group,
			openSource: func() (io.ReadCloser, error) { return conn.client.Open(item.Path) },
			openDest:   func() (io.WriteCloser, error) { return os.Create(local) },
			cleanupPartial: func() {
				_ = os.Remove(local)
			},
		}); err != nil {
			return err
		}
	}
	return nil
}

// streamTransfer 对应 TS streamTransfer：pkg/sftp 没有可取消的 fastGet/fastPut，
// 自己接管读写循环。每个 Read 块累计进度并推事件；取消或出错时关掉两端，
// 单文件传输删掉没传完的残留（下载删本地文件，上传删远程文件），
// 聚合传输不删残留，由遍历方在每个文件开始前检查 cancelled 停下。
func (s *Service) streamTransfer(opts transferOptions) error {
	group := opts.group
	id := ""
	if group != nil {
		id = group.id
	} else {
		id = randomID()
	}
	var transferred atomic.Int64
	push := func(done bool, errText string) {
		ev := TransferEvent{
			ID:          id,
			SessionID:   opts.sessionID,
			Direction:   opts.direction,
			Name:        opts.name,
			Transferred: transferred.Load(),
			Total:       opts.total,
			Done:        done,
			Error:       errText,
		}
		if group != nil {
			ev.Direction = group.direction
			ev.Name = group.name
			ev.Transferred = group.transferred.Load()
			ev.Total = group.total
		}
		s.emitTransfer(ev)
	}
	if group == nil {
		push(false, "")
	}

	src, err := opts.openSource()
	if err != nil {
		if group == nil {
			push(true, err.Error())
		}
		return err
	}
	dst, err := opts.openDest()
	if err != nil {
		_ = src.Close()
		if group == nil {
			push(true, err.Error())
		}
		return err
	}

	var mu sync.Mutex
	settled := false
	var result error
	finish := func(cause error) {
		mu.Lock()
		if settled {
			mu.Unlock()
			return
		}
		settled = true
		result = cause
		mu.Unlock()

		_ = src.Close()
		_ = dst.Close()
		if group != nil {
			return
		}
		s.unregisterTransfer(id)
		if cause != nil {
			// 文件句柄释放是异步的，稍等一下再删残留
			cleanup := opts.cleanupPartial
			time.AfterFunc(100*time.Millisecond, func() {
				defer func() { _ = recover() }()
				if cleanup != nil {
					cleanup()
				}
			})
			push(true, cause.Error())
		} else {
			transferred.Store(opts.total)
			push(true, "")
		}
	}

	if group != nil {
		group.setAbort(func() { finish(ErrCancelled) })
	} else {
		s.registerTransfer(id, func() { finish(ErrCancelled) })
	}

	buf := make([]byte, chunkSize)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			written, writeErr := dst.Write(buf[:n])
			if written > 0 {
				transferred.Add(int64(written))
				if group != nil {
					group.transferred.Add(int64(written))
				}
				push(false, "")
			}
			if writeErr != nil {
				finish(writeErr)
				break
			}
			if written != n {
				finish(io.ErrShortWrite)
				break
			}
		}
		if readErr == io.EOF {
			// 关掉写端确认落盘；字节数够了才算传完（取消/出错也会走到这里）
			if closeErr := dst.Close(); closeErr != nil {
				finish(closeErr)
			} else if transferred.Load() >= opts.total {
				finish(nil)
			} else {
				finish(errInterrupted)
			}
			break
		}
		if readErr != nil {
			finish(readErr)
			break
		}
	}
	mu.Lock()
	defer mu.Unlock()
	return result
}

// beginGroup 文件夹传输开始：聚合成一条进度，取消时标记 cancelled 并毁掉正在传的那个文件。
func (s *Service) beginGroup(sessionID, direction, name string, total int64) *transferGroup {
	group := &transferGroup{id: randomID(), sessionID: sessionID, direction: direction, name: name, total: total}
	s.registerTransfer(group.id, func() {
		group.cancelled.Store(true)
		group.mu.Lock()
		abort := group.abort
		group.mu.Unlock()
		if abort != nil {
			abort()
		}
	})
	s.emitTransfer(TransferEvent{ID: group.id, SessionID: sessionID, Direction: direction, Name: name, Total: total})
	return group
}

// endGroup 整棵树传完（或出错、取消）时收尾：推 done 并摘掉取消入口。
func (s *Service) endGroup(group *transferGroup, errText string) {
	s.unregisterTransfer(group.id)
	ev := TransferEvent{
		ID:        group.id,
		SessionID: group.sessionID,
		Direction: group.direction,
		Name:      group.name,
		Total:     group.total,
		Done:      true,
		Error:     errText,
	}
	if errText != "" {
		ev.Transferred = group.transferred.Load()
	} else {
		ev.Transferred = group.total
	}
	s.emitTransfer(ev)
}

func (s *Service) registerTransfer(id string, cancel func()) {
	s.mu.Lock()
	s.active[id] = cancel
	s.mu.Unlock()
}

func (s *Service) unregisterTransfer(id string) {
	s.mu.Lock()
	delete(s.active, id)
	s.mu.Unlock()
}

// localTreeSize 对应 TS localTreeSize：本地目录整棵的字节数。
func localTreeSize(dir string) (int64, error) {
	var total int64
	items, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	for _, item := range items {
		path := filepath.Join(dir, item.Name())
		if item.IsDir() {
			n, err := localTreeSize(path)
			if err != nil {
				return 0, err
			}
			total += n
			continue
		}
		info, err := item.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		total += info.Size()
	}
	return total, nil
}

// remoteTreeSize 对应 TS remoteTreeSize：远程目录整棵的字节数，给聚合进度当 total。
func remoteTreeSize(conn *liveConn, dir string) (int64, error) {
	var total int64
	entries, err := readdir(conn.client, dir)
	if err != nil {
		return 0, err
	}
	for _, item := range entries {
		if item.Kind == KindDir {
			n, err := remoteTreeSize(conn, item.Path)
			if err != nil {
				return 0, err
			}
			total += n
			continue
		}
		if item.Kind != KindFile {
			continue
		}
		size, err := statSize(conn.client, item.Path)
		if err != nil {
			return 0, err
		}
		total += size
	}
	return total, nil
}

// randomID 对应 TS randomBytes(6).toString('hex')。
func randomID() string {
	var buf [6]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf[:])
}
