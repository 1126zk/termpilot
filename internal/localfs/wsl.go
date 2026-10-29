package localfs

import (
	"errors"
	"path"
	"strings"
)

func wslUNCPath(distro, home, raw string) (string, error) {
	p := strings.TrimSpace(strings.ReplaceAll(raw, `\`, "/"))
	if mounted, ok := wslUNCMountedDrive(p); ok {
		return mounted, nil
	}
	if strings.HasPrefix(p, "//") || len(p) >= 2 && p[1] == ':' {
		return p, nil
	}
	if p != "" && p != "." && p != "~" && !strings.HasPrefix(p, "~/") && !strings.HasPrefix(p, "/") {
		return p, nil
	}
	if mounted, ok := mountedDrivePath(p); ok {
		return mounted, nil
	}
	if distro == "" || strings.ContainsAny(distro, `/\`) {
		return "", errors.New("WSL 发行版名称无效")
	}
	if !strings.HasPrefix(home, "/") {
		return "", errors.New("WSL 主目录无效")
	}
	switch {
	case p == "" || p == "." || p == "~":
		p = home
	case strings.HasPrefix(p, "~/"):
		p = path.Join(home, strings.TrimPrefix(p, "~/"))
	default:
		p = path.Clean(p)
	}
	return "//wsl.localhost/" + distro + path.Clean(p), nil
}

func wslUNCMountedDrive(p string) (string, bool) {
	parts := strings.SplitN(p, "/", 5)
	if len(parts) != 5 || parts[0] != "" || parts[1] != "" || parts[3] == "" ||
		!strings.EqualFold(parts[2], "wsl.localhost") && !strings.EqualFold(parts[2], "wsl$") {
		return "", false
	}
	return mountedDrivePath("/" + parts[4])
}

func mountedDrivePath(p string) (string, bool) {
	if len(p) < 6 || !strings.EqualFold(p[:5], "/mnt/") ||
		!(p[5] >= 'a' && p[5] <= 'z' || p[5] >= 'A' && p[5] <= 'Z') || len(p) > 6 && p[6] != '/' {
		return "", false
	}
	drive := strings.ToUpper(p[5:6])
	if len(p) == 6 {
		return drive + ":/", true
	}
	return drive + ":" + path.Clean(p[6:]), true
}
