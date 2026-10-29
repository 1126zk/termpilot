package localfs

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestWSLUNCPath(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "default home", raw: ".", want: "//wsl.localhost/Ubuntu/home/jack"},
		{name: "empty home", raw: "", want: "//wsl.localhost/Ubuntu/home/jack"},
		{name: "tilde home", raw: "~", want: "//wsl.localhost/Ubuntu/home/jack"},
		{name: "tilde child", raw: "~/src/app", want: "//wsl.localhost/Ubuntu/home/jack/src/app"},
		{name: "absolute", raw: "/etc/nginx", want: "//wsl.localhost/Ubuntu/etc/nginx"},
		{name: "mounted C root", raw: "/mnt/c", want: "C:/"},
		{name: "mounted C child", raw: "/mnt/c/Users/jack", want: "C:/Users/jack"},
		{name: "mounted D child", raw: "/mnt/d/work", want: "D:/work"},
		{name: "UNC mounted C root", raw: `\\wsl.localhost\Ubuntu\mnt\c`, want: "C:/"},
		{name: "UNC mounted C child", raw: `\\wsl$\Ubuntu\mnt\c\Users\jack`, want: "C:/Users/jack"},
		{name: "similar WSL directory", raw: "/mnt/code", want: "//wsl.localhost/Ubuntu/mnt/code"},
		{name: "existing UNC", raw: `\\wsl.localhost\Ubuntu\home\jack`, want: "//wsl.localhost/Ubuntu/home/jack"},
		{name: "legacy UNC", raw: `\\wsl$\Ubuntu\home\jack`, want: "//wsl$/Ubuntu/home/jack"},
		{name: "Windows drive", raw: `C:\Users\jack`, want: "C:/Users/jack"},
		{name: "relative", raw: "src/app", want: "src/app"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := wslUNCPath("Ubuntu", "/home/jack", tt.raw)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("wslUNCPath(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestWSLUNCPathRejectsInvalidInfo(t *testing.T) {
	if _, err := wslUNCPath("", "/home/jack", "~"); err == nil {
		t.Fatal("空发行版名称应拒绝")
	}
	if _, err := wslUNCPath("Ubuntu", "home/jack", "~"); err == nil {
		t.Fatal("相对主目录应拒绝")
	}
}

func TestToNativeWSLMountedDrive(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("盘符语义只在 Windows 上验证")
	}
	got, err := New().ToNative(`\\wsl.localhost\Ubuntu-24.04\mnt\c\Users\jack`)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.FromSlash("C:/Users/jack")
	if got != want {
		t.Fatalf("ToNative = %q, want %q", got, want)
	}
}
