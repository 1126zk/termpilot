import net from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import type { ForwardRule } from '../shared/types'

const LOOPBACK = '127.0.0.1'

/**
 * 把会话的端口映射挂到已经连好的共享 SSH 连接上，每条连接只挂一次。
 * local 对应 ssh -L，remote 对应 ssh -R。两头的 IP 都固定 127.0.0.1，用户只配端口。
 * 单条规则失败（端口被占等）只记日志，不影响其他规则和连接本身；
 * 连接关闭时统一回收监听。
 */
export function attachForwards(client: Client, forwards: ForwardRule[] | undefined): void {
  if (!forwards?.length) return
  const servers: net.Server[] = []
  const cleanups: (() => void)[] = []
  for (const rule of forwards) {
    try {
      if (rule.type === 'local') servers.push(startLocal(client, rule))
      else startRemote(client, rule, cleanups)
    } catch (error) {
      console.error(`[TermPilot] 端口映射失败 ${rule.type} :${rule.listenPort}`, error)
    }
  }
  let torn = false
  const teardown = () => {
    if (torn) return
    torn = true
    for (const server of servers) {
      try {
        server.close()
      } catch {
        /* 已经关了 */
      }
    }
    for (const cleanup of cleanups) cleanup()
  }
  client.once('close', teardown)
  client.once('end', teardown)
}

/** ssh -L：本机 127.0.0.1 监听，来一条连接就用 forwardOut 打通到服务器上的目标端口，双向转发。 */
function startLocal(client: Client, rule: ForwardRule): net.Server {
  const server = net.createServer((socket) => {
    client.forwardOut(LOOPBACK, rule.listenPort, LOOPBACK, rule.targetPort, (error, channel) => {
      if (error || !channel) {
        socket.destroy()
        return
      }
      socket.pipe(channel).pipe(socket)
      socket.on('error', () => channel.close())
      channel.on('error', () => socket.destroy())
    })
  })
  listen(server, rule)
  return server
}

/** ssh -R：让服务器 127.0.0.1 监听，连接进来时 accept 通道并接回本机目标端口。端口被占只报错，不影响其他规则。 */
function startRemote(client: Client, rule: ForwardRule, cleanups: (() => void)[]): void {
  const onConnection = (info: { destIP: string; destPort: number }, accept: () => ClientChannel) => {
    if (info.destPort !== rule.listenPort) return
    const channel = accept()
    const socket = net.connect(rule.targetPort, LOOPBACK)
    channel.pipe(socket).pipe(channel)
    socket.on('error', () => channel.close())
    channel.on('error', () => socket.destroy())
  }
  client.on('tcp connection', onConnection)
  client.forwardIn(LOOPBACK, rule.listenPort, (error) => {
    if (!error) return
    console.error(`[TermPilot] 远程转发失败 127.0.0.1:${rule.listenPort}: ${error.message}`)
    client.removeListener('tcp connection', onConnection)
  })
  cleanups.push(() => {
    client.removeListener('tcp connection', onConnection)
    client.unforwardIn(LOOPBACK, rule.listenPort, () => undefined)
  })
}

function listen(server: net.Server, rule: ForwardRule): void {
  server.on('error', (error) => {
    console.error(`[TermPilot] 端口映射监听失败 127.0.0.1:${rule.listenPort}: ${error.message}`)
  })
  server.listen(rule.listenPort, LOOPBACK)
}
