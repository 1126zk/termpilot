package sshx

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// dockerScript 一次性采集容器、镜像、卷和网络。先探测有没有 docker，没有就标记出来，
// 前端显示占位而不是报错。--format json 逐行输出，比按列解析稳。
const dockerScript = `
echo '#TP-HAVE#'
command -v docker >/dev/null 2>&1 && echo yes || echo no
echo '#TP-PS#'
docker ps -a --format '{{json .}}' 2>/dev/null
echo '#TP-IMAGES#'
docker images --format '{{json .}}' 2>/dev/null
echo '#TP-VOLUMES#'
docker volume ls --format '{{json .}}' 2>/dev/null
echo '#TP-NETWORKS#'
docker network ls --format '{{json .}}' 2>/dev/null
echo '#TP-END#'
`

// CollectDocker 采一次 Docker 容器、镜像、卷和网络列表，只在面板 Docker 页激活时调用。
func (s *ExecService) CollectDocker(sessionID string) (*DockerInfo, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: dockerScript, TimeoutMs: 10000})
	if err != nil {
		return nil, err
	}
	sec := splitSections(res.Stdout)
	info := &DockerInfo{
		Available:  strings.TrimSpace(sec["HAVE"]) == "yes",
		Containers: []DockerContainer{},
		Images:     []DockerImage{},
		Volumes:    []DockerVolume{},
		Networks:   []DockerNetwork{},
	}
	if !info.Available {
		return info, nil
	}
	for _, line := range strings.Split(sec["PS"], "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row struct {
			ID     string `json:"ID"`
			Names  string `json:"Names"`
			Image  string `json:"Image"`
			State  string `json:"State"`
			Status string `json:"Status"`
			Ports  string `json:"Ports"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		info.Containers = append(info.Containers, DockerContainer{
			ID:     row.ID,
			Name:   row.Names,
			Image:  row.Image,
			State:  row.State,
			Status: row.Status,
			Ports:  row.Ports,
		})
	}
	for _, line := range strings.Split(sec["IMAGES"], "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row struct {
			Repository   string `json:"Repository"`
			Tag          string `json:"Tag"`
			ID           string `json:"ID"`
			Size         string `json:"Size"`
			CreatedSince string `json:"CreatedSince"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		info.Images = append(info.Images, DockerImage{
			Repository: row.Repository,
			Tag:        row.Tag,
			ID:         row.ID,
			Size:       row.Size,
			Created:    row.CreatedSince,
		})
	}
	for _, line := range strings.Split(sec["VOLUMES"], "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row struct {
			Name   string `json:"Name"`
			Driver string `json:"Driver"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		info.Volumes = append(info.Volumes, DockerVolume{
			Name:   row.Name,
			Driver: row.Driver,
		})
	}
	for _, line := range strings.Split(sec["NETWORKS"], "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row struct {
			ID     string `json:"ID"`
			Name   string `json:"Name"`
			Driver string `json:"Driver"`
			Scope  string `json:"Scope"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		info.Networks = append(info.Networks, DockerNetwork{
			ID:     row.ID,
			Name:   row.Name,
			Driver: row.Driver,
			Scope:  row.Scope,
		})
	}
	return info, nil
}

// dockerIDRe 容器/镜像 id 只接受十六进制（sha256: 前缀先剥掉），防命令注入。
var dockerIDRe = regexp.MustCompile(`^[a-f0-9]{12,64}$`)

// dockerObjNameRe 卷/网络按名字操作，走 docker 命名规则（字母数字开头，可含 ._-），防命令注入。
var dockerObjNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

// dockerNameRe 导出文件名只留字母数字和 ._-，其余折叠成下划线。
var dockerNameRe = regexp.MustCompile(`[^\w.-]+`)

// DockerAction 对容器/镜像/卷/网络执行动作。action 只认白名单里的子命令；容器和镜像按
// id（纯十六进制），卷和网络按名字（docker 命名规则）。save 把镜像导出到远端 $HOME
// 下（下载走文件面板），返回导出文件的绝对路径，其他动作返回空串。
func (s *ExecService) DockerAction(sessionID, action, target, name string) (string, error) {
	target = strings.TrimPrefix(target, "sha256:")
	if action == "volume-rm" || action == "network-rm" {
		if !dockerObjNameRe.MatchString(target) {
			return "", fmt.Errorf("非法的名字：%q", target)
		}
	} else if !dockerIDRe.MatchString(target) {
		return "", fmt.Errorf("非法的 id：%q", target)
	}
	timeoutMs := 15000
	var cmd string
	switch action {
	case "start", "stop", "restart", "rmi":
		cmd = "docker " + action + " " + target
	case "rm":
		// 运行中的容器也能删，面板操作就不用先停了
		cmd = "docker rm -f " + target
	case "volume-rm":
		cmd = "docker volume rm " + target
	case "network-rm":
		cmd = "docker network rm " + target
	case "save":
		base := dockerNameRe.ReplaceAllString(name, "_")
		if base == "" || base == "." || base == ".." {
			base = target
		}
		cmd = fmt.Sprintf(`docker save %s -o "$HOME/%s.tar" && echo "$HOME/%s.tar"`, target, base, base)
		timeoutMs = 120000 // 大镜像导出慢
	default:
		return "", fmt.Errorf("不支持的动作：%q", action)
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: cmd, TimeoutMs: timeoutMs})
	if err != nil {
		return "", err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return "", fmt.Errorf("docker %s 失败（退出码 %d）：%s", action, *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	if action == "save" {
		return strings.TrimSpace(res.Stdout), nil
	}
	return "", nil
}
