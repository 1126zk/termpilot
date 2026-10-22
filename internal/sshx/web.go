package sshx

import (
	"fmt"
	"strings"
)

// 面板管的网站服务一律容器化，配置和数据统一收在 $HOME/.termpilot/<名字>/ 下，
// 删容器后删掉对应目录即完全干净。宿主机上 apt 装的 nginx/caddy 面板不管。

// webScript 一次性采集 nginx/caddy 容器状态和配置原文。先探测有没有 docker；
// 容器用 docker inspect 按固定名字查，不存在则状态为空串。HASCONF 段区分
// "配置文件不存在"和"存在但为空"，前端分开提示。
const webScript = `
echo '#TP-DOCKER#'
command -v docker >/dev/null 2>&1 && echo yes || echo no
echo '#TP-NGINX-STATE#'
docker inspect -f '{{.State.Status}}' nginx 2>/dev/null
echo '#TP-NGINX-HASCONF#'
ls "$HOME"/.termpilot/nginx/conf.d/*.conf >/dev/null 2>&1 && echo yes || echo no
echo '#TP-NGINX-CONF#'
for f in "$HOME"/.termpilot/nginx/conf.d/*.conf; do [ -f "$f" ] && echo "# ── $f" && cat "$f"; done
echo '#TP-CADDY-STATE#'
docker inspect -f '{{.State.Status}}' caddy 2>/dev/null
echo '#TP-CADDY-HASCONF#'
[ -f "$HOME/.termpilot/caddy/Caddyfile" ] && echo yes || echo no
echo '#TP-CADDY-CONF#'
cat "$HOME/.termpilot/caddy/Caddyfile" 2>/dev/null
echo '#TP-END#'
`

// CollectWeb 采一次网站服务（容器化 nginx/caddy）的状态和配置，只在面板网站页激活时调用。
func (s *ExecService) CollectWeb(sessionID string) (*WebInfo, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: webScript, TimeoutMs: 10000})
	if err != nil {
		return nil, err
	}
	sec := splitSections(res.Stdout)
	return &WebInfo{
		DockerAvailable: strings.TrimSpace(sec["DOCKER"]) == "yes",
		Nginx: WebServiceInfo{
			State:   strings.TrimSpace(sec["NGINX-STATE"]),
			HasConf: strings.TrimSpace(sec["NGINX-HASCONF"]) == "yes",
			Conf:    strings.TrimSpace(sec["NGINX-CONF"]),
		},
		Caddy: WebServiceInfo{
			State:   strings.TrimSpace(sec["CADDY-STATE"]),
			HasConf: strings.TrimSpace(sec["CADDY-HASCONF"]) == "yes",
			Conf:    strings.TrimSpace(sec["CADDY-CONF"]),
		},
	}, nil
}

// webInstallScript 一键安装脚本：备目录、补种子文件、拉镜像、起容器。
// 固定命令无拼接，不存在注入面。pull 慢，超时给足。
func webInstallScript(name string) (string, bool) {
	switch name {
	case "nginx":
		// conf.d 留空 nginx 也能跑（没有任何 server 块）；种子一份注释模板，
		// 面板上有东西可看，也提示改完怎么 reload
		return `
mkdir -p "$HOME/.termpilot/nginx/conf.d"
if [ ! -f "$HOME/.termpilot/nginx/conf.d/default.conf" ]; then
  cat > "$HOME/.termpilot/nginx/conf.d/default.conf" <<'EOF'
# 站点配置写在这里，改完执行：docker exec nginx nginx -s reload
# server {
#     listen 80;
#     server_name example.com;
#     root /usr/share/nginx/html;
# }
EOF
fi
docker pull nginx:alpine
docker run -d --name nginx --restart unless-stopped \
  -p 80:80 -p 443:443 \
  -v "$HOME/.termpilot/nginx/conf.d:/etc/nginx/conf.d" \
  nginx:alpine
`, true
	case "caddy":
		// 空配置 caddy 启动即退出，会被 restart 策略拉成崩溃循环（nginx 没这个问题），
		// 所以播种一份最小可用配置；文件缺失或为空（! -s）都补。
		// data（证书）和 config（autosave）也映射到目录，容器重建状态不丢
		return `
mkdir -p "$HOME/.termpilot/caddy/data" "$HOME/.termpilot/caddy/config"
if [ ! -s "$HOME/.termpilot/caddy/Caddyfile" ]; then
  cat > "$HOME/.termpilot/caddy/Caddyfile" <<'EOF'
# 站点配置写在这里，改完执行：docker exec caddy caddy reload --config /etc/caddy/Caddyfile
:80 {
    respond "caddy is running"
}
EOF
fi
docker pull caddy:alpine
docker run -d --name caddy --restart unless-stopped \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -v "$HOME/.termpilot/caddy/Caddyfile:/etc/caddy/Caddyfile" \
  -v "$HOME/.termpilot/caddy/data:/data" \
  -v "$HOME/.termpilot/caddy/config:/config" \
  caddy:alpine
`, true
	default:
		return "", false
	}
}

// WebInstall 一键安装 nginx/caddy 容器。name 只认白名单里的两个。
func (s *ExecService) WebInstall(sessionID, name string) error {
	script, ok := webInstallScript(name)
	if !ok {
		return fmt.Errorf("不支持的安装目标：%q", name)
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 300000})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("安装 %s 失败（退出码 %d）：%s", name, *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}
