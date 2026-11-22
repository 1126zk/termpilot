package sftpx

import (
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/pkg/sftp"
)

const errSameName = "目标里已经有同名的文件或文件夹"

// 目标上这个路径现在是什么。
type destKind int

const (
	destNone destKind = iota
	destFile
	destDir
)

// 边收边发时，读端最多领先写端这么多块。写得慢就停下来等，不把整份文件堆在内存里。
const relayAhead = 4

// Relay 把一台机器上的文件或目录经本机转发到另一台的目标目录。
// 读一块就写一块，不在本机落整份文件。源文件留在原地。
// mode 为空且目标已有同名时拒绝。skip 留下已有文件，只传还没有的。
// overwrite 用源文件换掉同名文件，没有的也传。两边都不先删掉整个目标目录。
func (s *Service) Relay(fromID, fromPath, toID, toDir, mode string) error {
	if fromID == "" || toID == "" {
		return errors.New("先选择两边的主机")
	}
	fromConn, err := s.sftpOf(fromID)
	if err != nil {
		return err
	}
	toConn, err := s.sftpOf(toID)
	if err != nil {
		return err
	}
	st, err := statOn(fromConn, fromPath)
	if err != nil {
		return present(err)
	}
	name, dest, err := relayCheck(st.path, toDir, fromID == toID)
	if err != nil {
		return err
	}
	exists, err := existsOn(toConn, dest)
	if err != nil {
		return present(err)
	}
	if exists && mode == "" {
		return errors.New(errSameName)
	}
	var total int64
	if mode == "skip" {
		total, err = plannedSize(fromConn, toConn, st.path, dest, st.isDir, mode)
	} else if st.isDir {
		err = fromConn.using(st.path, func(target string) error {
			st.path = target
			total, err = remoteTreeSize(fromConn, target)
			return err
		})
	} else {
		err = fromConn.using(st.path, func(target string) error {
			st.path = target
			total, err = statSize(fromConn.client, target)
			return err
		})
	}
	if err != nil {
		return present(err)
	}
	if mode == "skip" && total == 0 {
		return nil
	}
	group := s.beginGroup(toID, DirectionRelay, name, total)
	if st.isDir {
		err = s.relayTree(fromConn, toConn, st.path, dest, mode, group)
	} else {
		if mode == "overwrite" {
			kind, kindErr := kindOn(toConn, dest)
			if kindErr != nil {
				s.endGroup(group, kindErr.Error())
				return present(kindErr)
			}
			if _, remove, _ := relayStep(mode, false, kind); remove {
				if rmErr := removeKind(toConn, dest, kind); rmErr != nil {
					s.endGroup(group, rmErr.Error())
					return present(rmErr)
				}
			}
		}
		err = s.relayOne(fromConn, toConn, st.path, dest, total, group)
	}
	if err != nil {
		if cancelled(err) || group.cancelled.Load() {
			s.endGroup(group, ErrCancelled.Error())
			return ErrCancelled
		}
		s.endGroup(group, err.Error())
		return present(err)
	}
	s.endGroup(group, "")
	return nil
}

func (s *Service) relayTree(from, to *liveConn, fromDir, destDir, mode string, group *transferGroup) error {
	if group.cancelled.Load() {
		return ErrCancelled
	}
	kind, err := kindOn(to, destDir)
	if err != nil {
		return err
	}
	_, remove, descend := relayStep(mode, true, kind)
	if !descend {
		return nil
	}
	if remove {
		if err := removeKind(to, destDir, kind); err != nil {
			return err
		}
	}
	_ = to.using(destDir, func(target string) error {
		destDir = target
		return to.client.Mkdir(target)
	})
	entries, err := readdir(from.client, fromDir)
	if err != nil {
		return err
	}
	for _, item := range entries {
		if group.cancelled.Load() {
			return ErrCancelled
		}
		dest := remoteJoin(destDir, item.Name)
		if item.Kind == KindDir {
			if err := s.relayTree(from, to, item.Path, dest, mode, group); err != nil {
				return err
			}
			continue
		}
		if item.Kind != KindFile {
			continue
		}
		fileKind, err := kindOn(to, dest)
		if err != nil {
			return err
		}
		write, removeFile, _ := relayStep(mode, false, fileKind)
		if !write {
			continue
		}
		if removeFile {
			if err := removeKind(to, dest, fileKind); err != nil {
				return err
			}
		}
		if err := s.relayOne(from, to, item.Path, dest, item.Size, group); err != nil {
			return err
		}
	}
	return nil
}

// relayStep 决定这个源条目怎么处理。write 表示要写出这个文件，remove 表示先清掉目标上类型不同的条目，descend 表示走进目录。
func relayStep(mode string, sourceDir bool, dest destKind) (write, remove, descend bool) {
	if sourceDir {
		if mode == "skip" && dest == destFile {
			return false, false, false
		}
		if mode == "overwrite" && dest == destFile {
			return false, true, true
		}
		return false, false, true
	}
	if mode == "skip" && dest != destNone {
		return false, false, false
	}
	if mode == "overwrite" && dest == destDir {
		return true, true, false
	}
	return true, false, false
}

func (s *Service) relayOne(from, to *liveConn, fromPath, destPath string, size int64, group *transferGroup) error {
	if group.cancelled.Load() {
		return ErrCancelled
	}
	var src *sftp.File
	if err := from.using(fromPath, func(target string) error {
		file, err := from.client.Open(target)
		if err != nil {
			return err
		}
		src = file
		return nil
	}); err != nil {
		return err
	}
	defer src.Close()

	var dst *sftp.File
	var created string
	if err := to.using(destPath, func(target string) error {
		file, err := to.client.Create(target)
		if err != nil {
			return err
		}
		dst = file
		created = target
		return nil
	}); err != nil {
		return err
	}

	group.setAbort(func() {
		_ = src.Close()
		_ = dst.Close()
	})
	before := group.transferred.Load()
	err := s.relayPipe(src, dst, group)
	closeErr := dst.Close()
	if err != nil || (group.cancelled.Load()) {
		_ = to.client.Remove(created)
		if err == nil || cancelled(err) || group.cancelled.Load() {
			return ErrCancelled
		}
		return err
	}
	if closeErr != nil {
		_ = to.client.Remove(created)
		return closeErr
	}
	if got := group.transferred.Load() - before; got < size {
		_ = to.client.Remove(created)
		return errInterrupted
	}
	return nil
}

// relayPipe 从一个连接读、向另一个连接写。读端可以领先几块，写端按写到目标的字节数报进度。
func (s *Service) relayPipe(src io.Reader, dst io.Writer, group *transferGroup) error {
	chunks := make(chan []byte, relayAhead)
	errc := make(chan error, 1)
	stop := make(chan struct{})
	var once sync.Once
	halt := func() { once.Do(func() { close(stop) }) }

	go func() {
		defer close(chunks)
		buf := make([]byte, chunkSize)
		for {
			if group != nil && group.cancelled.Load() {
				return
			}
			n, err := src.Read(buf)
			if n > 0 {
				block := make([]byte, n)
				copy(block, buf[:n])
				select {
				case chunks <- block:
				case <-stop:
					return
				}
			}
			if err == io.EOF {
				return
			}
			if err != nil {
				select {
				case errc <- err:
				case <-stop:
				}
				return
			}
		}
	}()

	for block := range chunks {
		if group != nil && group.cancelled.Load() {
			halt()
			return ErrCancelled
		}
		off := 0
		for off < len(block) {
			n, err := dst.Write(block[off:])
			if n > 0 {
				off += n
				if group != nil {
					group.transferred.Add(int64(n))
					s.emitTransfer(TransferEvent{
						ID:          group.id,
						SessionID:   group.sessionID,
						Direction:   group.direction,
						Name:        group.name,
						Transferred: group.transferred.Load(),
						Total:       group.total,
					})
				}
			}
			if err != nil {
				halt()
				return err
			}
			if n == 0 {
				halt()
				return io.ErrShortWrite
			}
		}
	}
	halt()
	select {
	case err := <-errc:
		return err
	default:
		return nil
	}
}

type remoteInfo struct {
	path  string
	isDir bool
}

func statOn(conn *liveConn, p string) (remoteInfo, error) {
	var st remoteInfo
	err := conn.using(normalizeRemotePath(p), func(target string) error {
		info, err := conn.client.Stat(target)
		if err != nil {
			return err
		}
		st.path = target
		st.isDir = info.IsDir()
		return nil
	})
	return st, err
}

func kindOn(conn *liveConn, p string) (destKind, error) {
	var kind destKind
	err := conn.using(normalizeRemotePath(p), func(target string) error {
		info, err := conn.client.Lstat(target)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			kind = destFile
			return nil
		}
		kind = destDir
		return nil
	})
	if noSuchFile(err) {
		return destNone, nil
	}
	return kind, err
}

func removeKind(conn *liveConn, p string, kind destKind) error {
	if kind == destNone {
		return nil
	}
	return conn.using(normalizeRemotePath(p), func(target string) error {
		if kind == destDir {
			return removeDir(conn, target, 0)
		}
		return conn.client.Remove(target)
	})
}

// plannedSize 跳过时只算还要写出的字节。已经在的文件不算进进度。
func plannedSize(from, to *liveConn, fromPath, destPath string, sourceDir bool, mode string) (int64, error) {
	kind, err := kindOn(to, destPath)
	if err != nil {
		return 0, err
	}
	write, _, descend := relayStep(mode, sourceDir, kind)
	if sourceDir {
		if !descend {
			return 0, nil
		}
		entries, err := readdir(from.client, fromPath)
		if err != nil {
			return 0, err
		}
		var total int64
		for _, item := range entries {
			if item.Kind != KindDir && item.Kind != KindFile {
				continue
			}
			n, err := plannedSize(from, to, item.Path, remoteJoin(destPath, item.Name), item.Kind == KindDir, mode)
			if err != nil {
				return 0, err
			}
			total += n
		}
		return total, nil
	}
	if !write {
		return 0, nil
	}
	return statSize(from.client, fromPath)
}

func existsOn(conn *liveConn, p string) (bool, error) {
	var exists bool
	err := conn.using(normalizeRemotePath(p), func(target string) error {
		_, statErr := conn.client.Stat(target)
		if statErr == nil {
			exists = true
			return nil
		}
		return statErr
	})
	if noSuchFile(err) {
		return false, nil
	}
	return exists, err
}

// relayCheck 用已经解析过的源路径，算出要落到目标目录下的名字。
func relayCheck(fromPath, toDir string, sameSession bool) (string, string, error) {
	fromPath = path.Clean(normalizeRemotePath(fromPath))
	toDir = path.Clean(normalizeRemotePath(dirOrDot(toDir)))
	name := remoteBase(fromPath)
	if fromPath == "/" || name == "" || name == "." || name == ".." || name == "/" {
		return "", "", errors.New("不能传根目录")
	}
	dest := remoteJoin(toDir, name)
	if !sameSession {
		return name, dest, nil
	}
	if fromPath == dest || fromPath == toDir {
		return "", "", errors.New("它已经在这个目录里")
	}
	if strings.HasPrefix(toDir, fromPath+"/") || strings.HasPrefix(dest, fromPath+"/") {
		return "", "", errors.New("不能传到自身或它里面的目录")
	}
	return name, dest, nil
}

func cancelled(err error) bool {
	return err != nil && (errors.Is(err, ErrCancelled) || err.Error() == ErrCancelled.Error())
}
