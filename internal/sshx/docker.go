package sshx

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// dockerScript 一次性采集容器、镜像、卷、网络和 daemon.json。先探测有没有 docker，没有就标记出来，
// 前端显示占位而不是报错。--format json 逐行输出，比按列解析稳。
const dockerScript = `
echo '#TP-HAVE#'
command -v docker >/dev/null 2>&1 && echo yes || echo no
echo '#TP-RUNNING#'
docker info >/dev/null 2>&1 && echo yes || echo no
echo '#TP-PS#'
docker ps -a --format '{{json .}}' 2>/dev/null
echo '#TP-IMAGES#'
docker images --format '{{json .}}' 2>/dev/null
echo '#TP-VOLUMES#'
docker volume ls --format '{{json .}}' 2>/dev/null
echo '#TP-NETWORKS#'
docker network ls --format '{{json .}}' 2>/dev/null
echo '#TP-DAEMON#'
cat /etc/docker/daemon.json 2>/dev/null
echo '#TP-END#'
`

// CollectDocker 采一次 Docker 容器、镜像、卷、网络列表和 daemon.json，只在面板 Docker 页激活时调用。
func (s *ExecService) CollectDocker(sessionID string) (*DockerInfo, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: dockerScript, TimeoutMs: 10000})
	if err != nil {
		return nil, err
	}
	sec := splitSections(res.Stdout)
	info := &DockerInfo{
		Available:  strings.TrimSpace(sec["HAVE"]) == "yes",
		Running:    strings.TrimSpace(sec["RUNNING"]) == "yes",
		Containers: []DockerContainer{},
		Images:     []DockerImage{},
		Volumes:    []DockerVolume{},
		Networks:   []DockerNetwork{},
	}
	if !info.Available {
		return info, nil
	}
	info.DaemonJson = strings.TrimSpace(sec["DAEMON"])
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

// dockerInstallScript 一键装 docker：标准 apt 源流程（keyring + docker.list + 安装），
// 源列表由前端传入（面板可编辑），%s 处填入逐个引号包好的地址。不用 get.docker.com
// 脚本——它的镜像参数只支持阿里云一家。
const dockerInstallScript = `
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "不支持的发行版：$ID（只支持 Ubuntu/Debian）" >&2; exit 1;; esac
try_repo() {
  base="$1"
  echo "==> 尝试源：$base"
  install -m 0755 -d /etc/apt/keyrings || return 1
  rm -f /etc/apt/keyrings/docker.asc
  curl -fsSL --connect-timeout 8 --max-time 30 "$base/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc || return 1
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] $base/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -o Acquire::Retries=1 || return 1
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
}
ok=""
for base in %s; do
  try_repo "$base" && { ok=1; break; }
done
[ -n "$ok" ] || { echo "所有源都装不上，看上面输出找原因" >&2; exit 1; }
systemctl enable --now docker
docker info >/dev/null
`

// 默认源列表：国内权威源优先，官方兜底。面板可编辑，前端传空时用它。
var dockerDefaultMirrors = []string{
	"https://mirrors.aliyun.com/docker-ce",
	"https://mirrors.tuna.tsinghua.edu.cn/docker-ce",
	"https://mirrors.ustc.edu.cn/docker-ce",
	"https://mirrors.huaweicloud.com/docker-ce",
	"https://mirrors.tencent.com/docker-ce",
	"https://download.docker.com",
}

// dockerMirrorRe 源地址白名单：必须 https，主机名+路径字符集，防注入。
var dockerMirrorRe = regexp.MustCompile(`^https://[a-zA-Z0-9.-]+(/[a-zA-Z0-9._/-]*)?$`)

// dockerServiceScripts docker 服务级操作。uninstall 清包和数据目录，但不动 ~/.termpilot（用户的网站数据）。
var dockerServiceScripts = map[string]string{
	"start":   "systemctl start docker",
	"stop":    "systemctl stop docker docker.socket containerd",
	"restart": "systemctl restart docker",
	"uninstall": `
systemctl stop docker docker.socket containerd 2>/dev/null
apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
rm -rf /var/lib/docker /var/lib/containerd
rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc
`,
}

// DockerService docker 服务级操作（启动/停止/重启/卸载），op 走白名单。
func (s *ExecService) DockerService(sessionID, op string) error {
	script, ok := dockerServiceScripts[op]
	if !ok {
		return fmt.Errorf("不支持的操作：%q", op)
	}
	timeoutMs := 30000
	if op == "uninstall" {
		timeoutMs = 300000 // 卸包慢
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: timeoutMs})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("docker %s 失败（退出码 %d）：%s", op, *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

// InstallDocker 一键装 docker：按传入的源列表顺序尝试，装系统包慢，超时给足。
func (s *ExecService) InstallDocker(sessionID string, mirrors []string) error {
	if len(mirrors) == 0 {
		mirrors = dockerDefaultMirrors
	}
	quoted := make([]string, 0, len(mirrors))
	for _, m := range mirrors {
		if !dockerMirrorRe.MatchString(m) {
			return fmt.Errorf("非法的源地址：%q", m)
		}
		quoted = append(quoted, `"`+m+`"`)
	}
	script := fmt.Sprintf(dockerInstallScript, strings.Join(quoted, " "))
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 600000})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("安装 Docker 失败（退出码 %d）：%s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}
