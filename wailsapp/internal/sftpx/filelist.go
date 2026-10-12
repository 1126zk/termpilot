package sftpx

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strings"
)

// 对应 src/shared/file-listing.ts 与 SftpService.ts 里的尺寸/排序规则。

// MaxEditBytes 编辑器只打开 1.5MB 以内的文本文件（TS MAX_EDIT_BYTES）。
const MaxEditBytes = 1_500_000

// MaxTransferBytes 单文件传输上限 512MB（TS MAX_TRANSFER_BYTES）。
const MaxTransferBytes = 512 * 1024 * 1024

// AssertEditSize 对应 TS assertEditSize。
func AssertEditSize(size int64) error {
	if size > MaxEditBytes {
		return errors.New("文件超过 1.5MB，不在编辑器里打开")
	}
	return nil
}

// AssertTextBuffer 对应 TS assertTextBuffer：含 NUL 字节按二进制拒绝。
func AssertTextBuffer(buf []byte) error {
	if bytes.IndexByte(buf, 0) >= 0 {
		return errors.New("这是二进制文件，不能用文本编辑器打开")
	}
	return nil
}

// CompareRemoteFiles 目录在前，同级按名字排。对应 TS compareRemoteFiles；
// TS 用 localeCompare，这里退化为按字节序比较（slices.SortStableFunc 用）。
func CompareRemoteFiles(a, b RemoteFile) int {
	aDir, bDir := a.Kind == KindDir, b.Kind == KindDir
	if aDir && !bDir {
		return -1
	}
	if !aDir && bDir {
		return 1
	}
	return strings.Compare(a.Name, b.Name)
}

// refuseHuge 对应 TS refuseHuge：超过 512MB 拒绝，文案与原版一致。
func refuseHuge(size int64) error {
	if size <= MaxTransferBytes {
		return nil
	}
	gb := float64(size) / (1024 * 1024 * 1024)
	var text string
	if gb >= 1 {
		text = fmt.Sprintf("%.1f GB", gb)
	} else {
		text = fmt.Sprintf("%d MB", int64(math.Ceil(float64(size)/(1024*1024))))
	}
	return fmt.Errorf("文件有 %s，超过 512 MB。SFTP 不适合传几个 GB，请在远程机器上直接处理。", text)
}
