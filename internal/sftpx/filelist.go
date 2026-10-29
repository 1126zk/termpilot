package sftpx

import (
	"bytes"
	"errors"
	"strings"
)

// 对应 src/shared/file-listing.ts 与 SftpService.ts 里的尺寸/排序规则。

// MaxEditBytes 编辑器只打开 20MB 以内的文本文件（TS MAX_EDIT_BYTES）。
const MaxEditBytes = 20 * 1024 * 1024

// AssertEditSize 对应 TS assertEditSize。
func AssertEditSize(size int64) error {
	if size > MaxEditBytes {
		return errors.New("文件超过 20MB，不在编辑器里打开")
	}
	return nil
}

// MaxImageBytes 图片预览上限。整张图转成 base64 交给界面，太大会卡住窗口。
const MaxImageBytes = 20 * 1024 * 1024

// AssertImageSize 图片超过预览上限时拒绝。
func AssertImageSize(size int64) error {
	if size > MaxImageBytes {
		return errors.New("图片超过 20MB，不在预览里打开")
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
