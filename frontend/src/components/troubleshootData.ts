/** 排查页数据：应急 playbook。按症状分卡，每步 = 命令 + 这步在看什么。
    断网断电断 AI 都能用，从上往下一步步走，哪步出线索就停在哪步处理。 */

export interface TriageStep {
  cmd: string
  note: string
}

export interface TriageScenario {
  id: string
  title: string
  steps: TriageStep[]
}

export const TRIAGE_SCENARIOS: TriageScenario[] = [
  {
    id: 'site-down',
    title: '网站打不开',
    steps: [
      { cmd: 'curl -I https://你的域名', note: '通不通、什么状态码。超时 = 网络/端口问题；502 = 后端挂了；404 是配置问题' },
      { cmd: 'ss -tlnp | grep -E ":80|:443"', note: '80/443 有没有进程在听，听的是谁' },
      { cmd: 'docker ps', note: 'nginx/caddy 容器活没活，没活就去 Docker 页启动' },
      { cmd: 'docker logs caddy --tail 50', note: '看网关报错（名字换成 nginx 同理）' },
      { cmd: 'ping 你的域名', note: '解析出来的 IP 对不对——不对就是 DNS 解析没指过来' }
    ]
  },
  {
    id: 'disk-full',
    title: '磁盘满了',
    steps: [
      { cmd: 'df -h', note: '看哪个挂载点 100%（一般是 /）' },
      { cmd: 'du -sh /* 2>/dev/null | sort -rh | head', note: '找出哪个一级目录最大，往里面逐层 du 下钻' },
      { cmd: 'docker system df', note: 'docker 占了多少——镜像/构建缓存经常是大头' },
      { cmd: 'lsof +L1', note: '删了文件空间没释放？被进程占着的已删文件在这，重启对应进程才释放' },
      { cmd: 'journalctl --vacuum-time=7d && docker system prune -f', note: '确认大头后清理：日志只留 7 天 + 清 docker 垃圾' }
    ]
  },
  {
    id: 'high-load',
    title: '机器卡、负载高',
    steps: [
      { cmd: 'uptime', note: '三个负载数和核数比（核数用 nproc 看）。持续超过核数 = 真超载' },
      { cmd: 'top', note: '按 P 按 CPU 排、按 M 按内存排，第一名的进程就是嫌疑犯' },
      { cmd: 'free -h', note: 'available 还剩多少；swap 在猛用说明内存真不够' },
      { cmd: 'ps aux --sort=-%cpu | head', note: '不用 top 的静态快照版' },
      { cmd: 'iostat -x 1 3', note: '（没有就 apt install sysstat）%util 接近 100 = 磁盘 IO 是瓶颈' }
    ]
  },
  {
    id: 'no-network',
    title: '网络不通',
    steps: [
      { cmd: 'ping -c 3 114.114.114.114', note: '通 = 外网好的，问题在 DNS；不通 = 真断网，查网线/网卡/安全组' },
      { cmd: 'ping -c 3 baidu.com', note: 'IP 通域名不通 → DNS 坏，看 /etc/resolv.conf 里的 nameserver' },
      { cmd: 'ip addr && ip route', note: '网卡拿到 IP 没有、默认网关有没有' },
      { cmd: 'curl -v https://www.baidu.com', note: '看卡在哪一步：解析 / 连接 / TLS' },
      { cmd: '云服务器控制台查安全组', note: '入方向端口放没放、有没有误封自己' }
    ]
  },
  {
    id: 'service-down',
    title: '服务起不来',
    steps: [
      { cmd: 'systemctl status 服务名', note: '第一眼看状态，最后几行就是报错摘要' },
      { cmd: 'journalctl -u 服务名 -e', note: '翻到日志最后的真实报错' },
      { cmd: 'ss -tlnp | grep 端口号', note: '起不来常见原因：端口被占了，看谁占的' },
      { cmd: '改完配置先验证再重启', note: 'nginx -t / caddy validate / sshd -t，配置有错就别 restart' },
      { cmd: 'systemctl daemon-reload', note: '改了 unit 文件本身忘了这个，改动不生效' }
    ]
  },
  {
    id: 'docker-pull',
    title: 'docker 拉不动镜像',
    steps: [
      { cmd: 'Ctrl+C 停掉，别干等', note: '卡住的基本是网络问题，等不出结果' },
      { cmd: 'cat /etc/docker/daemon.json', note: 'registry-mirrors 配没配、配的源还活不活' },
      { cmd: 'docker pull docker.m.daocloud.io/仓库:标签', note: '显式走某个加速源试，通了再 docker tag 改回标准名' },
      { cmd: 'systemctl reload docker', note: '改了 daemon.json 热加载，不用重启容器' },
      { cmd: '面板 Docker 页的"镜像加速"小节', note: '不想敲命令就在面板上加/删源，等价' }
    ]
  }
]
