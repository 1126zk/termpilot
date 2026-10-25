/** 手册页数据：系统讲透一个主题。纯静态内容，断网可用。
    content 按纯文本渲染（whitespace-pre-wrap），命令行用两个空格缩进排版。 */

export interface ManualTopic {
  id: string
  title: string
  content: string
}

export const MANUAL_TOPICS: ManualTopic[] = [
  {
    id: 'cron',
    title: 'cron 定时任务',
    content: `cron 是 Linux 自带的定时器：一个常驻的 cron 守护进程每分钟醒一次，翻任务表（crontab），到点的行就执行，执行完拉倒。任务没有"运行中"的状态，表里的行就是它的全部。

一行任务的组成：
  分 时 日 月 星期  命令
  * * * * *  bash /root/job.sh

符号：* 每个都匹配；*/n 每隔 n；, 列举（1,15）；- 范围（1-5 周一到周五）
另有 @daily @hourly @weekly @reboot 这类关键字顶替五个字段。

操作表的命令：
  crontab -l        列出当前任务
  crontab -e        编辑
  crontab -         从标准输入整体替换（不是追加！先读出来拼上再写回）

坑：
· 日和星期同时写（都不是 *）是"或"关系：0 3 13 * 5 = 每月13号 或 每周五
· 命令里裸写的 % 会被当换行，要写成 \\%
· cron 的环境很精简，PATH 只有 /usr/bin:/bin，脚本里命令最好写绝对路径
· 任务没有日志，要排错就自己重定向：bash job.sh >> /var/log/job.log 2>&1`
  },
  {
    id: 'docker',
    title: 'Docker 四个概念',
    content: `镜像（image）：只读的模板，类比"安装包"。
容器（container）：镜像跑起来的实例，类比"装好的正在跑的程序"。同一镜像可以跑多个容器。
卷（volume）：挂载进容器的数据目录，容器删了数据还在。
网络（network）：容器之间/容器和外界怎么连通。host 模式 = 直接用宿主机网络栈，没有端口映射这一层。

常用命令流：
  docker ps -a              看容器（-a 含已停止的）
  docker images             看镜像
  docker logs -f 名字       跟日志
  docker exec -it 名字 sh   进容器（有 bash 换 bash）
  docker stop/rm 名字       停 / 删容器
  docker rmi 镜像           删镜像（有容器在用会拒）
  docker system df          docker 占了多少磁盘
  docker system prune -f    清掉没人用的容器/镜像/网络

删镜像按 id 删会带走它所有标签；按 仓库:标签 删只摘一个标签。`
  },
  {
    id: 'perm',
    title: 'Linux 权限',
    content: `每个文件有三组权限：属主 / 同组 / 其他人，每组三个位：r 读(4) w 写(2) x 执行(1)。

数字写法就是每组加起来：
  755 = rwxr-xr-x   目录和可执行文件的常见值
  644 = rw-r--r--   普通文件的常见值
  600 = rw-------   私钥这类只给自己看的

  chmod 755 file         改权限位
  chmod +x script.sh     加可执行
  chown user:group file  改属主和组
  chown -R user:group dir 目录递归

坑：
· 目录的 x 是"能进去"的意思。目录没 x，里面文件权限再宽也进不去
· 写文件看文件的 w；在目录里增删文件看目录的 w+x，和文件本身无关
· root 不受权限约束，排查权限问题先确认自己是不是 root`
  },
  {
    id: 'sshkey',
    title: 'SSH 密钥登录',
    content: `原理：本地一对密钥，私钥自己留着，公钥放到服务器的 ~/.ssh/authorized_keys 里。
登录时服务器用公钥出题，本地用私钥答卷，全程不传输密码。

  ssh-keygen -t ed25519        生成密钥对（一路回车）
  ssh-copy-id user@host        把公钥推上服务器
  ssh user@host                登录
  ssh -p 2222 user@host        非标端口
  scp file user@host:/path/    传文件上去
  ssh -L 8080:127.0.0.1:80 user@host   本地 8080 转发到服务器的 80

坑：
· 服务器上 ~/.ssh 要 700，authorized_keys 要 600，错了 sshd 直接拒
· sshd_config 里 PasswordAuthentication no 之后密码就废了，先确认密钥能登再关
· 私钥泄露 = 家门钥匙丢了，服务器上删掉对应公钥那行即失效`
  },
  {
    id: 'systemd',
    title: 'systemd 服务管理',
    content: `systemd 是现代 Linux 的"总管家"：开机启动、进程拉起、崩溃重启、日志收集都归它。
每个被管的东西叫一个 unit，服务是 .service。

  systemctl status 名字     状态 + 最近几行日志
  systemctl start/stop/restart 名字
  systemctl enable 名字     开机自启（enable --now = 启用并立刻启动）
  systemctl reload 名字     热加载配置（不中断进程，读得动的才生效）
  systemctl daemon-reload   改了 unit 文件本身之后要跑这个
  journalctl -u 名字 -e     这个服务的日志翻到最后
  journalctl -u 名字 -f     跟着看
  journalctl --since "10 min ago"  按时间过滤

排查口诀：起不来先 status，报错详情 journalctl -u -e，改了配置先 daemon-reload。`
  },
  {
    id: 'disk',
    title: '磁盘与日志',
    content: `  df -h                    各挂载点用量（先看哪个满了）
  du -sh /path/*           这个目录下各项多大（逐层下钻找大头）
  du -sh /var/log/*        日志目录常客
  find / -size +500M -type f 2>/dev/null   全盘找 500M 以上的文件
  lsof +L1                 已删除但还被进程占着的文件（删了空间不释放就是这个）

日志两个大户：
  journalctl --disk-usage            systemd 日志占了多少
  journalctl --vacuum-time=7d        只留 7 天
  /var/log 下的老日志 find /var/log -name "*.log" -mtime +7 -delete

磁盘满了写不进东西，数据库会先崩，日志会先丢——df -h 是巡检第一站。`
  }
]
