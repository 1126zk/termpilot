package sshx

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 面板管的网站服务一律容器化，配置和数据统一收在 $HOME/.termpilot/<名字>/ 下，
// 删容器后删掉对应目录即完全干净。宿主机上 apt 装的 nginx/caddy 面板不管。

// webScript 一次性采集 nginx/caddy 容器状态和配置原文。先探测有没有 docker；
// 容器用 docker inspect 按固定名字查，不存在则状态为空串。配置文件逐个输出，
// 每份原文前面打一行 #TP-FILE:<路径> 标记，Go 侧按标记切成结构化列表。
const webScript = `
echo '#TP-DOCKER#'
command -v docker >/dev/null 2>&1 && echo yes || echo no
echo '#TP-NGINX-STATE#'
docker inspect -f '{{.State.Status}}' nginx 2>/dev/null
echo '#TP-NGINX-CONF#'
for f in "$HOME"/.termpilot/nginx/conf.d/*.conf; do [ -f "$f" ] && echo "#TP-FILE:$f" && cat "$f"; done
echo '#TP-CERTS#'
for c in "$HOME"/.termpilot/nginx/ssl/certs/*/fullchain.pem; do
  [ -f "$c" ] || continue
  echo "$(basename "$(dirname "$c")")|$(openssl x509 -enddate -noout -in "$c" 2>/dev/null | cut -d= -f2)"
done
echo '#TP-CADDY-STATE#'
docker inspect -f '{{.State.Status}}' caddy 2>/dev/null
echo '#TP-CADDY-CONF#'
f="$HOME/.termpilot/caddy/Caddyfile"; [ -f "$f" ] && echo "#TP-FILE:$f" && cat "$f"
for f in "$HOME"/.termpilot/caddy/sites/*.caddy; do [ -f "$f" ] && echo "#TP-FILE:$f" && cat "$f"; done
echo '#TP-END#'
`

// CollectWeb 采一次网站服务（容器化 nginx/caddy）的状态和配置，只在面板网站页激活时调用。
// Certs：nginx ssl 目录下各证书域名的剩余有效天数（openssl 读到期日换算），caddy 自动续不跟踪。
func (s *ExecService) CollectWeb(sessionID string) (*WebInfo, error) {
	res, err := s.Exec(sessionID, ExecOptions{Command: webScript, TimeoutMs: 10000})
	if err != nil {
		return nil, err
	}
	sec := splitSections(res.Stdout)
	certs := map[string]int{}
	for _, line := range strings.Split(sec["CERTS"], "\n") {
		line = strings.TrimSpace(line)
		parts := strings.SplitN(line, "|", 2)
		if len(parts) != 2 {
			continue
		}
		if t, err := time.Parse("Jan 2 15:04:05 2006 MST", parts[1]); err == nil {
			certs[parts[0]] = int(time.Until(t).Hours() / 24)
		}
	}
	return &WebInfo{
		DockerAvailable: strings.TrimSpace(sec["DOCKER"]) == "yes",
		Nginx: WebServiceInfo{
			State: strings.TrimSpace(sec["NGINX-STATE"]),
			Files: parseWebConfFiles(sec["NGINX-CONF"]),
		},
		Caddy: WebServiceInfo{
			State: strings.TrimSpace(sec["CADDY-STATE"]),
			Files: parseWebConfFiles(sec["CADDY-CONF"]),
		},
		Certs: certs,
	}, nil
}

// parseWebConfFiles 把采集输出按 #TP-FILE:<路径> 标记切成逐文件的（路径, 原文）列表。
// 原文里的空行保留；标记行之前的输出（异常噪音）丢弃。
func parseWebConfFiles(out string) []WebConfFile {
	files := []WebConfFile{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "#TP-FILE:") {
			files = append(files, WebConfFile{Path: strings.TrimPrefix(line, "#TP-FILE:")})
			continue
		}
		if len(files) == 0 {
			continue
		}
		f := &files[len(files)-1]
		if f.Content != "" {
			f.Content += "\n"
		}
		f.Content += line
	}
	// 拼接时行尾多出来的换行修掉
	for i := range files {
		files[i].Content = strings.TrimRight(files[i].Content, "\n")
	}
	return files
}

// caddyPlaceholder 占位站点：sites 目录空了 = 空配置 = caddy 启动即退出，
// 会被 restart 策略拉成崩溃循环，所以任何时刻保底要有一个站点。
const caddyPlaceholder = `# 占位站点：加一个真实站点后可以删除
:80 {
    respond "caddy is running"
}`

// caddySiteAddr caddy 站点地址：默认 80 只写域名（HTTP 80 + 自动 HTTPS 443）；
// 指定其他端口时带 http:// 前缀生成纯 HTTP 站点，非标准端口不去签证书。
func caddySiteAddr(domain, port string) string {
	if port == "80" {
		return domain
	}
	return "http://" + domain + ":" + port
}

// webInstallScript 一键安装脚本：备目录、补种子文件、拉镜像、起容器。
// 固定命令无拼接，不存在注入面。pull 慢，超时给足。
func webInstallScript(name string) (string, bool) {
	switch name {
	case "nginx":
		// conf.d 留空 nginx 也能跑（没有任何 server 块）；种子一份注释模板，
		// 面板上有东西可看，也提示改完怎么 reload。www 是静态站的网页目录（容器内 /usr/share/nginx/html）。
		// 网关角色用 host 网络（同 1Panel 的 OpenResty）：直接占宿主机 80/443，
		// 反代目标写 127.0.0.1:端口 即可，没有共享网络的心智负担
		return `
mkdir -p "$HOME/.termpilot/nginx/conf.d" "$HOME/.termpilot/nginx/www" "$HOME/.termpilot/nginx/ssl"
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
docker pull neilpang/acme.sh
docker run -d --name nginx --restart unless-stopped \
  --network host \
  -v "$HOME/.termpilot/nginx/conf.d:/etc/nginx/conf.d" \
  -v "$HOME/.termpilot/nginx/www:/usr/share/nginx/html" \
  -v "$HOME/.termpilot/nginx/ssl:/etc/nginx/ssl" \
  nginx:alpine
`, true
	case "caddy":
		// 主配置只做 import，站点一文件一个收在 sites/；网页文件放 www/（容器内 /srv）。
		// data（证书）和 config（autosave）也映射到目录，容器重建状态不丢。
		// 网络同 nginx 用 host 模式：直接占宿主机 80/443（含 UDP，HTTP/3 原生生效）
		return fmt.Sprintf(`
mkdir -p "$HOME/.termpilot/caddy/data" "$HOME/.termpilot/caddy/config" "$HOME/.termpilot/caddy/sites" "$HOME/.termpilot/caddy/www"
if [ ! -s "$HOME/.termpilot/caddy/Caddyfile" ]; then
  cat > "$HOME/.termpilot/caddy/Caddyfile" <<'EOF'
# 站点在 sites/ 目录里，一站点一文件；面板可增删，改完执行：docker exec caddy caddy reload --config /etc/caddy/Caddyfile
import /etc/caddy/sites/*.caddy
EOF
fi
if ! ls "$HOME"/.termpilot/caddy/sites/*.caddy >/dev/null 2>&1; then
  cat > "$HOME/.termpilot/caddy/sites/placeholder.caddy" <<'EOF'
%s
EOF
fi
docker pull caddy:alpine
docker run -d --name caddy --restart unless-stopped \
  --network host \
  -v "$HOME/.termpilot/caddy/Caddyfile:/etc/caddy/Caddyfile" \
  -v "$HOME/.termpilot/caddy/sites:/etc/caddy/sites" \
  -v "$HOME/.termpilot/caddy/www:/srv" \
  -v "$HOME/.termpilot/caddy/data:/data" \
  -v "$HOME/.termpilot/caddy/config:/config" \
  caddy:alpine
`, caddyPlaceholder), true
	default:
		return "", false
	}
}

// WebInstall 一键安装 nginx/caddy 容器。name 只认白名单里的两个。
// onLine 非空时 stdout 逐行回调（拉镜像进度实时下发）。
func (s *ExecService) WebInstall(sessionID, name string, onLine func(string)) error {
	script, ok := webInstallScript(name)
	if !ok {
		return fmt.Errorf("不支持的安装目标：%q", name)
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 300000, OnLine: onLine})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("安装 %s 失败（退出码 %d）：%s", name, *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

// 站点表单字段的白名单：全部会进文件名或配置内容，必须防注入。
var (
	webDomainRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
	webTargetRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+:[0-9]{1,5}$`)
	webDirRe    = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	webPortRe   = regexp.MustCompile(`^[0-9]{1,5}$`)
)

// WebSite 增删网站站点，service 只认 nginx/caddy。port 留空 = 80（caddy 还会自动占 443
// 签证书）；非 80 端口是纯 HTTP 站点。nginx 站点在 conf.d/<域名>.conf，caddy 在
// sites/<域名>.caddy；同名文件已存在直接报错不覆盖。容器在跑就先校验再热加载，
// 校验失败删掉刚写的文件并把报错抛给前端；没在跑就只落盘，下次启动生效。
func (s *ExecService) WebSite(sessionID, service, action, domain, port, siteType, target string) error {
	if !webDomainRe.MatchString(domain) {
		return fmt.Errorf("非法的域名：%q", domain)
	}
	if port == "" {
		port = "80"
	}
	if !webPortRe.MatchString(port) {
		return fmt.Errorf("非法的端口：%q", port)
	}
	if p, _ := strconv.Atoi(port); p < 1 || p > 65535 {
		return fmt.Errorf("端口超出范围（1-65535）：%q", port)
	}
	// 同域名多端口共存：add 时非 80 端口的文件名带端口后缀；
	// del 时前端传的 domain 就是文件名本体（可能已带端口后缀），直接用
	base := domain
	if action == "add" && port != "80" {
		base = domain + "." + port
	}
	var file, check, reload string
	switch service {
	case "nginx":
		file = fmt.Sprintf(`"$HOME/.termpilot/nginx/conf.d/%s.conf"`, base)
		check = "docker exec nginx nginx -t"
		reload = "docker exec nginx nginx -s reload"
	case "caddy":
		file = fmt.Sprintf(`"$HOME/.termpilot/caddy/sites/%s.caddy"`, base)
		check = "docker exec caddy caddy validate --config /etc/caddy/Caddyfile"
		reload = "docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
	default:
		return fmt.Errorf("不支持的服务：%q", service)
	}
	running := fmt.Sprintf(`[ "$(docker inspect -f '{{.State.Status}}' %s 2>/dev/null)" = "running" ]`, service)

	var script string
	switch action {
	case "add":
		var body, prepare string
		switch {		case service == "nginx" && siteType == "proxy":
			if !webTargetRe.MatchString(target) {
				return fmt.Errorf("非法的反代目标（要 host:port）：%q", target)
			}
			// ACME 挑战的 location 预留在每个站点里（签发时令牌才能被公网取到）；
			// 放在主 location 后面，提取 proxy_pass/root 时第一匹配才是真目标
			body = "server {\n    listen " + port + ";\n    server_name " + domain + ";\n    location / {\n        proxy_pass http://" + target + ";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    }\n    location ^~ /.well-known/acme-challenge/ {\n        root /usr/share/nginx/html;\n    }\n}"
		case service == "nginx" && siteType == "static":
			if !webDirRe.MatchString(target) {
				return fmt.Errorf("非法的目录名：%q", target)
			}
			prepare = fmt.Sprintf(`mkdir -p "$HOME/.termpilot/nginx/www/%s"`, target)
			body = "server {\n    listen " + port + ";\n    server_name " + domain + ";\n    root /usr/share/nginx/html/" + target + ";\n    index index.html;\n    location ^~ /.well-known/acme-challenge/ {\n        root /usr/share/nginx/html;\n    }\n}"
		case service == "caddy" && siteType == "proxy":
			if !webTargetRe.MatchString(target) {
				return fmt.Errorf("非法的反代目标（要 host:port）：%q", target)
			}
			body = caddySiteAddr(domain, port) + " {\n\treverse_proxy " + target + "\n}"
		case service == "caddy" && siteType == "static":
			if !webDirRe.MatchString(target) {
				return fmt.Errorf("非法的目录名：%q", target)
			}
			prepare = fmt.Sprintf(`mkdir -p "$HOME/.termpilot/caddy/www/%s"`, target)
			body = caddySiteAddr(domain, port) + " {\n\troot * /srv/" + target + "\n\tfile_server\n}"
		default:
			return fmt.Errorf("不支持的站点类型：%q", siteType)
		}
		// host 网络下 listen <port> 只绑 IPv4：宿主机有 IPv6 协议栈就补一行 listen [::]:<port>，
		// 没有就不写（避免绑 [::] 失败起不来）。caddy 默认双栈不用管。
		v6 := ""
		if service == "nginx" {
			v6 = fmt.Sprintf(`[ -f /proc/net/if_inet6 ] && sed -i 's/    listen %s;/    listen %s;\n    listen [::]:%s;/' %s`, port, port, port, file)
		}
		script = fmt.Sprintf(`
%s
if [ -f %s ]; then
  echo "站点已存在，先删除再加" >&2
  exit 1
fi
cat > %s <<'EOF'
%s
EOF
%s
if %s; then
  if ! %s; then
    rm -f %s
    exit 1
  fi
  %s
fi
`, prepare, file, file, body, v6, running, check, file, reload)
	case "del":
		if service == "caddy" {
			// 删空了就补回占位站点，防止 caddy 拿到空配置崩溃循环（nginx 没这问题）
			script = fmt.Sprintf(`
rm -f %s
if ! ls "$HOME"/.termpilot/caddy/sites/*.caddy >/dev/null 2>&1; then
  cat > "$HOME/.termpilot/caddy/sites/placeholder.caddy" <<'EOF'
%s
EOF
fi
if %s; then
  %s
fi
`, file, caddyPlaceholder, running, reload)
		} else {
			script = fmt.Sprintf(`
rm -f %s
if %s; then
  %s
fi
`, file, running, reload)
		}
	default:
		return fmt.Errorf("不支持的动作：%q", action)
	}
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 30000})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("%s 站点失败（退出码 %d）：%s", action, *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

// webIPv4Re 站点是 IPv4 地址时走自签：公网 CA 不给 IP 签证书。
var webIPv4Re = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)

// WebSSL nginx 站点的 HTTPS 开关：op=on 开启（没有证书先签），renew 强制续期重签，
// off 关闭（删 443 块，证书文件保留，再开直接用）。签发：域名走 acme.sh 一次性容器
// 的 ACME（webroot 挑战，80 端口），IP 走宿主机 openssl 自签（10 年期带 SAN，秒级）。
// 443 块从现有配置认 proxy_pass/root 追加，认不出的报错让手改；nginx -t 通过才 reload。
// 续期靠面板手动，不写定时任务。只支持 80 端口站点——挑战固定走 80。
func (s *ExecService) WebSSL(sessionID, domain, op string) error {
	if !webDomainRe.MatchString(domain) {
		return fmt.Errorf("非法的域名：%q", domain)
	}
	if op == "off" {
		return s.webSSLOff(sessionID, domain)
	}
	force := op == "renew"
	certsDir := "$HOME/.termpilot/nginx/ssl/certs/" + domain
	var issue string
	if webIPv4Re.MatchString(domain) {
		// IP：openssl 本地自签覆盖旧的，不拉镜像不联网
		issue = `openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "` + certsDir + `/privkey.pem" \
  -out "` + certsDir + `/fullchain.pem" \
  -days 3650 -subj "/CN=` + domain + `" -addext "subjectAltName=IP:` + domain + `"`
	} else {
		// 域名：acme.sh 一次性容器签发（续期带 --force 强制重签）+ 装到统一约定路径
		forceFlag := ""
		if force {
			forceFlag = " --force"
		}
		issue = `docker run --rm \
  -v "$HOME/.termpilot/nginx/www:/acme" \
  -v "$HOME/.termpilot/nginx/ssl:/acme.sh" \
  neilpang/acme.sh --issue -d ` + domain + ` -w /acme --home /acme.sh --server letsencrypt` + forceFlag + ` && \
docker run --rm \
  -v "$HOME/.termpilot/nginx/ssl:/acme.sh" \
  neilpang/acme.sh --install-cert -d ` + domain + ` --home /acme.sh \
  --key-file /acme.sh/certs/` + domain + `/privkey.pem \
  --fullchain-file /acme.sh/certs/` + domain + `/fullchain.pem`
	}
	forceShell := "0"
	if force {
		forceShell = "1"
	}
	script := fmt.Sprintf(`
conf="$HOME/.termpilot/nginx/conf.d/%[1]s.conf"
[ -f "$conf" ] || { echo "站点不存在：%[1]s" >&2; exit 1; }
[ "$(docker inspect -f '{{.State.Status}}' nginx 2>/dev/null)" = "running" ] || { echo "nginx 没在运行，先启动容器" >&2; exit 1; }
docker exec nginx test -d /etc/nginx/ssl || { echo "nginx 容器缺少 ssl 挂载，删掉重装一次一键安装即可" >&2; exit 1; }
mkdir -p "%[2]s" "$HOME/.termpilot/nginx/www"
if [ ! -f "%[2]s/fullchain.pem" ] || [ "%[4]s" = "1" ]; then
%[3]s || exit 1
fi
if ! grep -q 'listen 443 ssl' "$conf"; then
  target=$(sed -n 's/.*proxy_pass\s*http:\/\/\([^;[:space:]]*\).*/\1/p' "$conf" | head -1)
  rootdir=$(sed -n 's/.*root\s\+\([^;[:space:]]*\).*/\1/p' "$conf" | head -1)
  if [ -n "$target" ]; then
    cat >> "$conf" <<EOF

server {
    listen 443 ssl;
    server_name %[1]s;
    ssl_certificate /etc/nginx/ssl/certs/%[1]s/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/certs/%[1]s/privkey.pem;
    location / {
        proxy_pass http://$target;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
  elif [ -n "$rootdir" ]; then
    cat >> "$conf" <<EOF

server {
    listen 443 ssl;
    server_name %[1]s;
    ssl_certificate /etc/nginx/ssl/certs/%[1]s/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/certs/%[1]s/privkey.pem;
    root $rootdir;
    index index.html;
}
EOF
  else
    echo "认不出站点类型（像是手写配置），443 块请手动加" >&2
    exit 1
  fi
fi
if ! grep -q 'listen \[::\]:443' "$conf" && [ -f /proc/net/if_inet6 ]; then
  sed -i 's/    listen 443 ssl;/    listen 443 ssl;\n    listen [::]:443 ssl;/' "$conf"
fi
docker exec nginx nginx -t || exit 1
docker exec nginx nginx -s reload || exit 1
`, domain, certsDir, issue, forceShell)
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 300000})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("开启 HTTPS 失败（退出码 %d）：%s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

// webSSLOff 关掉站点的 HTTPS：把配置里带 listen 443 ssl 的 server 块整个删掉再 reload。
// 证书文件留着不动，重新开启直接用。awk 按块扫：块以行首 server { 开始、行首 } 结束，
// 不含 443 listen 的块原样保留。
func (s *ExecService) webSSLOff(sessionID, domain string) error {
	script := fmt.Sprintf(`
conf="$HOME/.termpilot/nginx/conf.d/%[1]s.conf"
[ -f "$conf" ] || { echo "站点不存在：%[1]s" >&2; exit 1; }
grep -q 'listen 443 ssl' "$conf" || exit 0
awk '
/^server \{/ { inblk=1; ssl=0; buf=$0; next }
inblk {
  buf = buf ORS $0
  if ($0 ~ /listen 443 ssl/) ssl=1
  if ($0 ~ /^}/) { if (!ssl) print buf; inblk=0 }
  next
}
{ print }
' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"
if [ "$(docker inspect -f '{{.State.Status}}' nginx 2>/dev/null)" = "running" ]; then
  docker exec nginx nginx -t || exit 1
  docker exec nginx nginx -s reload || exit 1
fi
`, domain)
	res, err := s.Exec(sessionID, ExecOptions{Command: script, TimeoutMs: 30000})
	if err != nil {
		return err
	}
	if res.ExitCode != nil && *res.ExitCode != 0 {
		return fmt.Errorf("关闭 HTTPS 失败（退出码 %d）：%s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}
