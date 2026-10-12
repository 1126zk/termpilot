// PNG → ICO（PNG 压缩条目，Vista+ 标准格式）。
// 用法: go run ./spikes/png2ico <in.png> <out.ico>
package main

import (
	"encoding/binary"
	"os"
)

func main() {
	png, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	// 源图是 256x256 的 TermPilot icon.png；ICO 目录项宽高字节 0 表示 256。
	out, err := os.Create(os.Args[2])
	if err != nil {
		panic(err)
	}
	defer out.Close()

	// ICONDIR: reserved(2)=0, type(2)=1, count(2)=1
	_ = binary.Write(out, binary.LittleEndian, uint16(0))
	_ = binary.Write(out, binary.LittleEndian, uint16(1))
	_ = binary.Write(out, binary.LittleEndian, uint16(1))
	// ICONDIRENTRY: w,h,colorCount,reserved, planes(2), bpp(2), size(4), offset(4)
	_, _ = out.Write([]byte{0, 0, 0, 0})
	_ = binary.Write(out, binary.LittleEndian, uint16(1))
	_ = binary.Write(out, binary.LittleEndian, uint16(32))
	_ = binary.Write(out, binary.LittleEndian, uint32(len(png)))
	_ = binary.Write(out, binary.LittleEndian, uint32(6+16))
	_, _ = out.Write(png)
}
