package sshx

import (
	"encoding/json"
	"strings"
)

// dockerScript 一次性采集容器和镜像。先探测有没有 docker，没有就标记出来，
// 前端显示占位而不是报错。--format json 逐行输出，比按列解析稳。
const dockerScript = `
echo '#TP-HAVE#'
command -v docker >/dev/null 2>&1 && echo yes || echo no
echo '#TP-PS#'
docker ps -a --format '{{json .}}' 2>/dev/null
echo '#TP-IMAGES#'
docker images --format '{{json .}}' 2>/dev/null
echo '#TP-END#'
`

// CollectDocker 采一次 Docker 容器和镜像列表，只在面板 Docker 页激活时调用。
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
	return info, nil
}
