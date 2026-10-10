"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/services/TerminalService.ts
var TerminalService_exports = {};
__export(TerminalService_exports, {
  TerminalService: () => TerminalService,
  detectLocalShells: () => detectLocalShells
});
module.exports = __toCommonJS(TerminalService_exports);
var import_node_module = require("node:module");
var import_node_child_process2 = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_ssh22 = require("ssh2");

// src/shared/ipc-channels.ts
var IPC = {
  sessionList: "session:list",
  sessionCreate: "session:create",
  sessionUpdate: "session:update",
  sessionDelete: "session:delete",
  sessionDuplicate: "session:duplicate",
  /** main → renderer，Agent 改了会话列表 */
  sessionChanged: "session:changed",
  hostNoteList: "host:note-list",
  hostNoteSet: "host:note-set",
  termSaved: "term:saved",
  /** 恢复窗口时取出上次退出时已经画好的行。不再回放原始流。 */
  termHistory: "term:history",
  /** 界面把当前缓冲里的行交给主进程存盘 */
  termScrollSave: "term:scroll-save",
  termBindView: "term:bind-view",
  termCreate: "term:create",
  termInput: "term:input",
  termResize: "term:resize",
  termClose: "term:close",
  /** 标签栏拖动排序后，按新顺序持久化 */
  termReorder: "term:reorder",
  /** renderer → main，窗口短标题变了 */
  termLabel: "term:label",
  /** main → renderer，助手改了终端备注 */
  termMeta: "term:meta",
  /** main → renderer 事件 */
  termData: "term:data",
  termStatus: "term:status",
  sftpList: "sftp:list",
  sftpMkdir: "sftp:mkdir",
  sftpRemove: "sftp:remove",
  sftpUpload: "sftp:upload",
  sftpDownload: "sftp:download",
  sftpUploadDir: "sftp:upload-dir",
  sftpDownloadDir: "sftp:download-dir",
  sftpRead: "sftp:read",
  sftpWrite: "sftp:write",
  sftpRename: "sftp:rename",
  /** main → renderer，安装 SFTP 的进度和远程日志 */
  sftpInstall: "sftp:install",
  /** 拖入上传：renderer 把本地路径数组交给主进程 */
  sftpUploadPaths: "sftp:upload-paths",
  /** main → renderer，单个文件传输进度 */
  sftpTransfer: "sftp:transfer",
  /** renderer → main，取消一条进行中的传输 */
  sftpTransferCancel: "sftp:transfer-cancel",
  snippetList: "snippet:list",
  snippetCreate: "snippet:create",
  snippetUpdate: "snippet:update",
  snippetDelete: "snippet:delete",
  historyList: "history:list",
  historyClear: "history:clear",
  /** main → renderer，写入了新的历史指令 */
  historyChanged: "history:changed",
  mcpAgents: "mcp:agents",
  mcpApplyAgent: "mcp:apply-agent",
  mcpAudit: "mcp:audit",
  mcpGet: "mcp:get",
  mcpSave: "mcp:save",
  appearanceGet: "appearance:get",
  appearanceSave: "appearance:save",
  mcpState: "mcp:state",
  mcpStateEvent: "mcp:state-event",
  mcpBound: "mcp:bound",
  mcpOpenTab: "mcp:open-tab",
  mcpCloseTab: "mcp:close-tab",
  mcpConfirm: "mcp:confirm",
  mcpConfirmReply: "mcp:confirm-reply",
  /** 截取页面上真实的终端视图 */
  capturePage: "capture:page",
  captureSave: "capture:save",
  captureReveal: "capture:reveal",
  captureCopy: "capture:copy",
  captureRead: "capture:read",
  captureRun: "capture:run",
  captureReply: "capture:reply",
  termLines: "term:lines",
  termLinesReply: "term:lines-reply",
  termMode: "term:mode",
  termModeReply: "term:mode-reply",
  appVersion: "app:version",
  /** 本机文件面板，参数为统一正斜杠路径，无 sessionId */
  localfsList: "localfs:list",
  localfsMkdir: "localfs:mkdir",
  localfsRemove: "localfs:remove",
  localfsUpload: "localfs:upload",
  localfsUploadPaths: "localfs:upload-paths",
  localfsDownload: "localfs:download",
  localfsUploadDir: "localfs:upload-dir",
  localfsDownloadDir: "localfs:download-dir",
  localfsRename: "localfs:rename",
  localfsRead: "localfs:read",
  localfsWrite: "localfs:write",
  sessionDetectOs: "session:detect-os",
  sessionSetOs: "session:set-os",
  shellsList: "shells:list",
  winMinimize: "win:minimize",
  winToggleMaximize: "win:toggle-maximize",
  winClose: "win:close",
  winIsMaximized: "win:is-maximized",
  winMaximizeChanged: "win:maximize-changed"
};

// src/main/ssh-config.ts
var import_node_child_process = require("node:child_process");
var import_node_stream = require("node:stream");
var import_ssh2 = require("ssh2");
function buildConnectConfig(session, secret) {
  const cfg = {
    host: session.host,
    port: session.port,
    username: session.username,
    password: secret ?? void 0,
    readyTimeout: 15e3,
    // 心跳保活：15 秒一个协议层心跳包，防 NAT / 防火墙 / 云主机空闲断连。
    // 连续 4 个没回应（约 1 分钟）就判定死亡，让池尽快清掉僵尸重拨，
    // 不要拖太久——拖久了 shell / exec / SFTP 会一直拿到死连接。
    keepaliveInterval: 15e3,
    keepaliveCountMax: 4
  };
  applyDialOptions(cfg, session.sshOptions);
  return cfg;
}
function dialSsh(session, secret, jumpSecret, client, opts) {
  const options = session.sshOptions;
  const hops = jumpHops(session, jumpSecret);
  if (hops.length === 0) {
    const cfg = buildConnectConfig(session, secret);
    if (options?.proxyCommand) cfg.sock = openProxyCommand(options.proxyCommand, session);
    connectClient(client, cfg);
    return void 0;
  }
  const opened = [];
  let dialFailed = false;
  const fail = (error) => {
    if (dialFailed) return;
    dialFailed = true;
    for (const hop of opened) hop.end();
    client.emit("error", error);
  };
  client.on("close", () => {
    for (const hop of opened) hop.end();
  });
  const connectHop = (index, sock) => {
    const hop = hops[index];
    const jump = new import_ssh2.Client();
    opened.push(jump);
    let failed = false;
    const hopFail = (error) => {
      if (failed) return;
      failed = true;
      fail(error);
    };
    jump.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => hop.password ?? ""));
    });
    jump.on("error", (error) => hopFail(new Error(`\u8DF3\u677F\u8FDE\u63A5\u5931\u8D25: ${error.message}`)));
    jump.on("ready", () => {
      const next = index + 1 < hops.length ? hops[index + 1] : { host: session.host, port: session.port || 22 };
      jump.forwardOut("127.0.0.1", 0, next.host, next.port, (error, stream) => {
        if (!error && stream) {
          if (index + 1 < hops.length) connectHop(index + 1, stream);
          else connectClient(client, { ...buildConnectConfig(session, secret), sock: stream });
          return;
        }
        const last = index === hops.length - 1;
        if (last && opts?.onJumpShell) {
          jump.shell({ term: "xterm-256color", cols: opts.cols ?? 80, rows: opts.rows ?? 24 }, (shellError, shell) => {
            if (shellError || !shell) {
              hopFail(new Error(`\u8DF3\u677F\u65E0\u6CD5\u8F6C\u5230\u76EE\u6807\u673A: ${error?.message ?? shellError?.message ?? "\u672A\u77E5\u539F\u56E0"}`));
              return;
            }
            loginTargetFromJump(shell, session, secret);
            opts.onJumpShell?.(shell);
          });
          return;
        }
        hopFail(new Error(`\u8DF3\u677F\u65E0\u6CD5\u8F6C\u5230\u76EE\u6807\u673A: ${error?.message ?? "\u672A\u77E5\u539F\u56E0"}`));
      });
    });
    const cfg = {
      host: hop.host,
      port: hop.port,
      username: hop.username,
      password: hop.password ?? void 0,
      tryKeyboard: true,
      readyTimeout: 2e4,
      keepaliveInterval: 15e3,
      keepaliveCountMax: 4
    };
    applyDialOptions(cfg, options);
    if (sock) cfg.sock = sock;
    connectClient(jump, cfg, hopFail);
  };
  connectHop(0);
  const head = opened[0];
  if (head) jumpChains.set(head, opened);
  return head;
}
function endJump(jump) {
  if (!jump) return;
  const hops = jumpChains.get(jump) ?? [jump];
  jumpChains.delete(jump);
  for (const hop of hops) hop.end();
}
var jumpChains = /* @__PURE__ */ new WeakMap();
function jumpHops(session, jumpSecret) {
  const host = session.jumpHost?.trim();
  if (!host) return [];
  let username = session.jumpUsername?.trim() || session.username;
  let password = jumpSecret;
  if (username.startsWith("jt_") && password && !username.includes(":")) {
    username = `${username}:${password}`;
    password = null;
  }
  const hops = [{ host, port: session.jumpPort || 22, username, password }];
  for (const extra of session.sshOptions?.extraJumps ?? []) {
    if (!extra.host.trim()) continue;
    hops.push({
      host: extra.host,
      port: extra.port || 22,
      username: extra.username.trim() || session.username,
      password: null
    });
  }
  return hops;
}
function connectClient(client, cfg, onError) {
  try {
    client.connect(cfg);
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (onError) onError(wrapped);
    else client.emit("error", wrapped);
  }
}
function applyDialOptions(cfg, options) {
  if (!options) return;
  if (options.readyTimeoutMs !== void 0) cfg.readyTimeout = options.readyTimeoutMs === 0 ? 12e4 : options.readyTimeoutMs;
  if (options.keepaliveIntervalMs !== void 0) cfg.keepaliveInterval = options.keepaliveIntervalMs;
  if (options.keepaliveCountMax !== void 0) cfg.keepaliveCountMax = options.keepaliveCountMax;
  if (options.localAddress) cfg.localAddress = options.localAddress;
  if (options.family === 4) cfg.forceIPv4 = true;
  if (options.family === 6) cfg.forceIPv6 = true;
  if (options.strictHostKeyChecking === "no" || options.strictHostKeyChecking === "accept-new") {
    cfg.hostVerifier = () => true;
  }
  const algorithms = toAlgorithms(options);
  if (algorithms) cfg.algorithms = algorithms;
}
function toAlgorithms(options) {
  const algorithms = {};
  const cipher = algoList(options.algorithms?.cipher);
  const kex = algoList(options.algorithms?.kex);
  const serverHostKey = algoList(options.algorithms?.serverHostKey);
  const hmac = algoList(options.algorithms?.hmac);
  if (cipher) algorithms.cipher = cipher;
  if (kex) algorithms.kex = kex;
  if (serverHostKey) algorithms.serverHostKey = serverHostKey;
  if (hmac) algorithms.hmac = hmac;
  if (options.compress) algorithms.compress = ["zlib@openssh.com", "zlib", "none"];
  return Object.keys(algorithms).length > 0 ? algorithms : void 0;
}
function algoList(values) {
  if (!values?.length) return void 0;
  const append = [];
  const prepend = [];
  const remove = [];
  const plain = [];
  for (const item of values) {
    if (item.startsWith("+")) append.push(item.slice(1));
    else if (item.startsWith("^")) prepend.push(item.slice(1));
    else if (item.startsWith("-")) remove.push(item.slice(1));
    else plain.push(item);
  }
  if (plain.length > 0) return plain;
  const patch = {};
  if (append.length > 0) patch.append = append;
  if (prepend.length > 0) patch.prepend = prepend;
  if (remove.length > 0) patch.remove = remove;
  return patch;
}
function openProxyCommand(command, target) {
  const expanded = command.replace(/%[%hpnr]/g, (token) => {
    if (token === "%%") return "%";
    if (token === "%h" || token === "%n") return target.host;
    if (token === "%p") return String(target.port || 22);
    if (token === "%r") return target.username;
    return token;
  });
  const child = (0, import_node_child_process.spawn)(expanded, { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const sock = new import_node_stream.Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk, encoding, callback) {
      child.stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      child.stdin.end();
      callback();
    },
    destroy(error, callback) {
      child.kill();
      callback(error);
    }
  });
  child.stdout.on("data", (chunk) => {
    if (!sock.push(chunk)) child.stdout.pause();
  });
  child.stdout.on("end", () => sock.push(null));
  child.on("error", (error) => sock.destroy(error));
  return sock;
}
function loginTargetFromJump(stream, session, secret) {
  const host = session.host.includes(":") && !session.host.startsWith("[") ? `[${session.host}]` : session.host;
  const port = session.port && session.port !== 22 ? ` -p ${session.port}` : "";
  const command = `ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o NumberOfPasswordPrompts=1${port} ${session.username}@${host}
`;
  let phase = "wait";
  const ask = () => {
    if (phase !== "wait") return;
    phase = "asked";
    stream.write(command);
  };
  const timer = setTimeout(ask, 1200);
  stream.on("data", (chunk) => {
    const text = stripControls(chunk.toString());
    if (/are you sure you want to continue connecting/i.test(text)) {
      stream.write("yes\n");
      return;
    }
    const askingPassword = /(?:password|passphrase|密码)\s*[:：]\s*$/i.test(text.trim());
    if (askingPassword && secret && phase !== "done") {
      clearTimeout(timer);
      phase = "done";
      stream.write(`${secret}
`);
      return;
    }
    if (phase === "wait" && /[#$>]\s*$/.test(text.trim())) {
      clearTimeout(timer);
      ask();
    }
  });
}
function stripControls(text) {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

// src/main/services/TerminalService.ts
var pty = null;
var ptyLoadError = null;
try {
  const req = (0, import_node_module.createRequire)((0, import_node_path.join)(__dirname, "require-shim.js"));
  pty = req("node-pty");
} catch (e) {
  ptyLoadError = e instanceof Error ? e.message : String(e);
  console.error("[TermPilot] node-pty \u52A0\u8F7D\u5931\u8D25\uFF08\u672C\u5730\u7EC8\u7AEF\u4E0D\u53EF\u7528\uFF09:", ptyLoadError);
}
var TerminalService = class {
  constructor(storage, getSender, sshPool) {
    this.storage = storage;
    this.getSender = getSender;
    this.sshPool = sshPool;
    this.hydrate();
  }
  terms = /* @__PURE__ */ new Map();
  output = /* @__PURE__ */ new Map();
  /** 上次退出时已经画好的行。打开窗口时按行写回，不再解析原始流。 */
  savedLines = /* @__PURE__ */ new Map();
  /** 缓冲从头部丢掉的字节数。用来在裁短之后仍只切出本次新增。 */
  dropped = /* @__PURE__ */ new Map();
  lastStatus = /* @__PURE__ */ new Map();
  statusListeners = /* @__PURE__ */ new Set();
  bindWaiters = /* @__PURE__ */ new Map();
  /** 界面已经订上输出。之前的内容先补一次，避免重启后的记录被新输出盖掉。 */
  viewReady = /* @__PURE__ */ new Set();
  /** 正在退出。此时断开不要把窗口从库里删掉。 */
  parking = false;
  /** 每扇终端正在输入的那一行。回车结算进历史指令。 */
  commandLines = /* @__PURE__ */ new Map();
  async create(opts) {
    const existing = this.terms.get(opts.termId);
    if (existing?.channel) return;
    if (existing && this.lastStatus.get(opts.termId)?.status === "connecting") return;
    if (opts.kind === "local") {
      this.createLocal(opts);
      return;
    }
    await this.createSsh(opts);
  }
  input(termId, data) {
    this.captureInput(termId, data);
    this.terms.get(termId)?.channel?.write(data);
  }
  /**
   * 按键流按行组装历史指令：回车结算一行；退格删一个字符；含方向键、粘贴换行等
   * 其他控制字符的行丢弃；strip 后少于 2 个字符的也丢弃。CRLF 里的 LF 不算控制字符。
   */
  captureInput(termId, data) {
    let state = this.commandLines.get(termId) ?? { buf: "", dirty: false, cr: false };
    for (const ch of data) {
      if (ch === "\r") {
        const command = state.buf.trim();
        if (!state.dirty && command.length >= 2 && this.storage.appendHistory(termId, command)) {
          const wc = this.getSender();
          if (wc && !wc.isDestroyed()) wc.send(IPC.historyChanged, termId);
        }
        state = { buf: "", dirty: false, cr: true };
        continue;
      }
      if (ch === "\n" && state.cr) {
        state.cr = false;
        continue;
      }
      state.cr = false;
      if (ch === "\x7F" || ch === "\b") {
        state.buf = state.buf.slice(0, -1);
        continue;
      }
      if (ch.charCodeAt(0) < 32) {
        state.dirty = true;
        continue;
      }
      state.buf += ch;
    }
    this.commandLines.set(termId, state);
  }
  resize(termId, cols, rows) {
    const t = this.terms.get(termId);
    if (!t || cols <= 0 || rows <= 0) return;
    try {
      t.channel?.resize?.(cols, rows);
    } catch {
    }
  }
  /**
   * 同一扇终端重新拨号。编号、标题、备注和已有输出都留着。
   * 已经连着时直接返回。
   */
  async reconnect(termId) {
    const term = this.terms.get(termId);
    if (!term) throw new Error("\u7EC8\u7AEF\u4E0D\u5B58\u5728\u6216\u5DF2\u5173\u95ED");
    if (term.kind !== "ssh" || !term.sessionId) throw new Error("\u672C\u673A\u7EC8\u7AEF\u65AD\u5F00\u540E\u4E0D\u4F1A\u4FDD\u7559\uFF0C\u8BF7\u7528 term_open_local \u518D\u5F00\u4E00\u6247");
    const session = this.storage.list().find((item) => item.id === term.sessionId);
    if (!session) throw new Error("\u8FD9\u6761\u8FDE\u63A5\u5DF2\u7ECF\u5220\u9664\u4E86");
    if (term.channel) return;
    if (this.lastStatus.get(termId)?.status === "connecting") {
      await this.waitStatus(termId, 2e4);
      return;
    }
    this.releaseLive(term);
    const pending = this.waitNextStatus(termId, 2e4);
    await this.create({
      termId,
      kind: "ssh",
      sessionId: term.sessionId,
      title: term.title,
      cols: 120,
      rows: 32
    });
    await pending;
  }
  /** 人关掉或助手关掉。编号不再恢复。 */
  close(termId) {
    const t = this.terms.get(termId);
    this.releaseLive(t);
    this.terms.delete(termId);
    this.output.delete(termId);
    this.savedLines.delete(termId);
    this.commandLines.delete(termId);
    this.dropped.delete(termId);
    this.lastStatus.delete(termId);
    this.viewReady.delete(termId);
    this.storage.forgetOpenTerm(termId);
  }
  /** 恢复窗口时取出上次退出时已经画好的行。不是原始流，按行写回即可。 */
  history(termId) {
    return { text: this.savedLines.get(termId) ?? "" };
  }
  /** 界面把当前缓冲里的行交过来。存这份，下次打开按行写回。 */
  saveScrollback(termId, text) {
    if (!this.terms.has(termId) || typeof text !== "string") return;
    this.storage.saveTermScrollback(termId, text);
  }
  /** 界面订上之后，把这次运行里已经到达、还没画上的输出补上。 */
  bindView(termId) {
    const text = this.output.get(termId) ?? "";
    const first = !this.viewReady.has(termId);
    this.viewReady.add(termId);
    if (first && text) this.push(termId, Buffer.from(text, "utf8"));
  }
  saved() {
    return this.storage.listOpenTerms().map((term) => ({
      id: term.id,
      sessionId: term.sessionId,
      kind: term.kind,
      title: term.title,
      remark: term.remark,
      shell: term.shell
    }));
  }
  listTerms() {
    return [...this.terms.values()].map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      kind: t.kind,
      status: this.lastStatus.get(t.id)?.status ?? "unknown",
      title: t.title,
      remark: t.remark
    }));
  }
  /** 窗口短标题或助手备注。编号不变。 */
  setLabel(termId, patch) {
    const term = this.terms.get(termId);
    if (!term) return;
    if (patch.title !== void 0) term.title = patch.title.trim().slice(0, 80) || term.title;
    if (patch.remark !== void 0) term.remark = patch.remark.trim().slice(0, 200);
    this.persist(term);
    this.sendMeta(term);
  }
  /** 界面把 xterm 订上之后再放行 SSH，避免登录横幅丢在订阅之前 */
  expectBind(termId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bindWaiters.delete(termId);
        reject(new Error("\u754C\u9762\u6CA1\u6709\u6253\u5F00\u7EC8\u7AEF"));
      }, timeoutMs);
      this.bindWaiters.set(termId, () => {
        clearTimeout(timer);
        this.bindWaiters.delete(termId);
        resolve();
      });
    });
  }
  markBound(termId) {
    this.bindWaiters.get(termId)?.();
  }
  waitStatus(termId, timeoutMs) {
    const current = this.lastStatus.get(termId);
    if (current?.status === "connected") return Promise.resolve();
    if (current?.status === "error") return Promise.reject(new Error(current.error ?? "\u8FDE\u63A5\u5931\u8D25"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusListeners.delete(onStatus);
        reject(new Error("\u8FDE\u63A5\u8D85\u65F6"));
      }, timeoutMs);
      const onStatus = (event) => {
        if (event.termId !== termId) return;
        if (event.status === "connected") {
          clearTimeout(timer);
          this.statusListeners.delete(onStatus);
          resolve();
        } else if (event.status === "error" || event.status === "disconnected") {
          clearTimeout(timer);
          this.statusListeners.delete(onStatus);
          reject(new Error(event.error ?? "\u8FDE\u63A5\u5931\u8D25"));
        }
      };
      this.statusListeners.add(onStatus);
    });
  }
  readTail(termId, maxChars) {
    if (!this.terms.has(termId)) throw new Error("\u7EC8\u7AEF\u4E0D\u5B58\u5728\u6216\u5DF2\u65AD\u5F00");
    return (this.output.get(termId) ?? "").slice(-maxChars);
  }
  /**
   * 等命令跑完再返回。完成信号是提示符：发命令前记下当时提示符的长相，
   * 等输出安静下来，最后一行又变回提示符就是跑完了。POSIX shell 还会顺手
   * 打一个看不见的标记带回退出码；本机 Windows 的 PowerShell 没有这一步，
   * 只靠提示符。到 timeoutMs 还没跑完，就把已经回来的内容交出去，命令还在远端跑。
   */
  async execCommand(termId, command, timeoutMs) {
    const term = this.terms.get(termId);
    if (!term?.channel) throw new Error("\u7EC8\u7AEF\u5DF2\u7ECF\u65AD\u5F00\u3002\u7528 term_reconnect \u6062\u590D\u8FD9\u6247\u7EC8\u7AEF\uFF0C\u7F16\u53F7\u4E0D\u53D8\u3002");
    const origin = this.logicalEnd(termId);
    const promptBefore = lastScreenLine(this.readTail(termId, 4e3));
    const body = command.endsWith("\n") ? command.slice(0, -1) : command;
    const posix = term.kind === "ssh" || process.platform !== "win32";
    const marker = `__TP_DONE_${Math.random().toString(36).slice(2, 10)}__`;
    const probe = posix ? `
printf '${marker}%s\\n\\033[2A\\033[2K\\033[1B\\033[2K\\033[1A' "$?"` : "";
    this.input(termId, `${body}${probe}
`);
    const deadline = Date.now() + timeoutMs;
    let exitCode = null;
    let finished = false;
    let seen = 0;
    let quietAt = Date.now();
    while (Date.now() < deadline) {
      await delay(100);
      const out = this.since(termId, origin);
      const found = posix ? out.match(new RegExp(`${marker}(\\d+)`)) : null;
      if (found) {
        exitCode = Number(found[1]);
        finished = true;
        break;
      }
      if (out.length !== seen) {
        seen = out.length;
        quietAt = Date.now();
        continue;
      }
      if (Date.now() - quietAt >= 600 && isPromptAgain(lastScreenLine(out), promptBefore)) {
        finished = true;
        break;
      }
    }
    const output = this.since(termId, origin).split("\n").filter((line) => !line.includes(marker)).join("\n");
    return { output, exitCode, finished };
  }
  /** 退出时断开。窗口编号和备注留着，输出不写入磁盘。 */
  disposeAll() {
    this.parking = true;
    for (const term of this.terms.values()) this.releaseLive(term);
    this.terms.clear();
    this.viewReady.clear();
  }
  // ---------------------------------------------------------------- ssh
  async createSsh(opts, retried = false) {
    const session = this.storage.list().find((s) => s.id === opts.sessionId);
    if (!session) {
      this.sendStatus(opts.termId, opts.sessionId ?? null, "error", "\u4F1A\u8BDD\u4E0D\u5B58\u5728");
      return;
    }
    const prior = this.terms.get(opts.termId);
    const entry = prior ?? {
      id: opts.termId,
      sessionId: session.id,
      kind: "ssh",
      title: opts.title?.trim() || "\u7A97\u53E3",
      remark: "",
      liveGen: 0
    };
    if (!prior) {
      this.terms.set(opts.termId, entry);
      this.persist(entry);
    }
    const gen = this.arm(entry);
    this.sendStatus(opts.termId, session.id, "connecting");
    const secret = this.storage.getSecret(session.id);
    const jumpSecret = this.storage.getJumpSecret(session.id);
    try {
      const hold = await this.sshPool.acquire(session, secret, jumpSecret);
      if (!this.alive(entry, gen)) {
        hold.release();
        return;
      }
      this.bindShared(entry, hold, opts, gen, retried);
      return;
    } catch (error) {
      if (!this.alive(entry, gen)) return;
      if (session.jumpHost?.trim() && isForwardDenied(error)) {
        this.openJumpShell(entry, opts, session, secret, jumpSecret, gen);
        return;
      }
      this.sendStatus(opts.termId, session.id, "error", error instanceof Error ? error.message : String(error));
    }
  }
  /** 转发已经通了。shell 开在这条会话上，不再向跳板要一次连接。 */
  bindShared(entry, hold, opts, gen, retried) {
    const sessionId = entry.sessionId;
    entry.release = hold.release;
    hold.client.on("error", (err) => {
      if (!this.alive(entry, gen)) return;
      this.releaseLive(entry);
      this.sendStatus(opts.termId, sessionId, "error", err.message);
    });
    hold.client.on("close", () => {
      if (!this.alive(entry, gen)) return;
      this.releaseLive(entry);
      this.sendStatus(opts.termId, sessionId, "disconnected");
    });
    hold.client.shell({ term: "xterm-256color", cols: opts.cols, rows: opts.rows }, (err, stream) => {
      if (!this.alive(entry, gen)) return;
      if (err || !stream) {
        if (!retried && sessionId) {
          this.releaseLive(entry);
          this.sshPool.drop(sessionId);
          void this.createSsh(opts, true);
          return;
        }
        this.sendStatus(opts.termId, sessionId, "error", `\u6253\u5F00 shell \u5931\u8D25: ${err?.message ?? "\u672A\u77E5\u539F\u56E0"}`);
        return;
      }
      entry.channel = sshChannel(stream);
      this.sendStatus(opts.termId, sessionId, "connected");
      stream.on("data", (d) => this.sendData(opts.termId, d));
      stream.stderr.on("data", (d) => this.sendData(opts.termId, d));
      stream.on("close", () => {
        if (!this.alive(entry, gen)) return;
        this.releaseLive(entry);
        this.sendStatus(opts.termId, sessionId, "disconnected");
      });
    });
  }
  /** 跳板不许转发时，只给终端在跳板里再登录一次。这条没有 SSH 会话，文件树用不上。 */
  openJumpShell(entry, opts, session, secret, jumpSecret, gen) {
    const client = new import_ssh22.Client();
    entry.client = client;
    client.on("error", (err) => {
      if (!this.alive(entry, gen)) return;
      this.releaseLive(entry);
      this.sendStatus(opts.termId, session.id, "error", err.message);
    }).on("close", () => {
      if (!this.alive(entry, gen)) return;
      this.releaseLive(entry);
      this.sendStatus(opts.termId, session.id, "disconnected");
    });
    try {
      entry.jump = dialSsh(session, secret, jumpSecret, client, {
        cols: opts.cols,
        rows: opts.rows,
        onJumpShell: (stream) => {
          if (!this.alive(entry, gen)) return;
          entry.channel = sshChannel(stream);
          this.sendStatus(opts.termId, session.id, "connected");
          stream.on("data", (d) => this.sendData(opts.termId, d));
          stream.stderr.on("data", (d) => this.sendData(opts.termId, d));
          stream.on("close", () => {
            if (!this.alive(entry, gen)) return;
            this.releaseLive(entry);
            this.sendStatus(opts.termId, session.id, "disconnected");
          });
        }
      });
    } catch (e) {
      if (!this.alive(entry, gen)) return;
      this.releaseLive(entry);
      this.sendStatus(opts.termId, session.id, "error", e instanceof Error ? e.message : String(e));
    }
  }
  // -------------------------------------------------------------- local
  createLocal(opts) {
    if (!pty) {
      this.sendStatus(
        opts.termId,
        null,
        "error",
        `node-pty \u4E0D\u53EF\u7528: ${ptyLoadError ?? "\u672A\u77E5\u539F\u56E0"}\uFF08\u539F\u751F\u6A21\u5757\u9700 electron-rebuild\uFF09`
      );
      return;
    }
    const shell = localShellExe(opts.shell);
    const prior = this.terms.get(opts.termId);
    const entry = prior ?? {
      id: opts.termId,
      sessionId: null,
      kind: "local",
      title: opts.title?.trim() || "\u7A97\u53E3",
      remark: "",
      shell: opts.shell ?? "powershell",
      liveGen: 0
    };
    if (!prior) {
      this.terms.set(opts.termId, entry);
      this.persist(entry);
    }
    try {
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: (0, import_node_os.homedir)(),
        env: process.env
      });
      entry.channel = ptyChannel(proc);
      this.sendStatus(opts.termId, null, "connected");
      proc.onData((d) => this.sendData(opts.termId, Buffer.from(d, "utf-8")));
      const gen = this.arm(entry);
      proc.onExit(() => {
        if (this.parking || !this.alive(entry, gen)) return;
        this.sendStatus(opts.termId, null, "disconnected");
        this.close(opts.termId);
      });
    } catch (e) {
      this.sendStatus(opts.termId, null, "error", e instanceof Error ? e.message : String(e));
    }
  }
  sendMeta(term) {
    const wc = this.getSender();
    if (!wc || wc.isDestroyed()) return;
    const payload = { termId: term.id, title: term.title, remark: term.remark };
    wc.send(IPC.termMeta, payload);
  }
  logicalEnd(termId) {
    return (this.dropped.get(termId) ?? 0) + (this.output.get(termId) ?? "").length;
  }
  /** 只取 origin 之后新写入的输出。缓冲从头部裁短时也不把更早的记录算进去。 */
  since(termId, origin) {
    const text = this.output.get(termId) ?? "";
    const from = origin - (this.dropped.get(termId) ?? 0);
    if (from >= 0 && from <= text.length) return text.slice(from);
    return text;
  }
  sendData(termId, data) {
    const prev = this.output.get(termId) ?? "";
    const next = prev + data.toString("utf8");
    if (next.length > 1e5) {
      const drop = next.length - 1e5;
      this.dropped.set(termId, (this.dropped.get(termId) ?? 0) + drop);
      this.output.set(termId, next.slice(drop));
    } else {
      this.output.set(termId, next);
    }
    if (this.viewReady.has(termId)) this.push(termId, data);
  }
  hydrate() {
    for (const saved of this.storage.listOpenTerms()) {
      if (saved.kind === "ssh" && !this.storage.list().some((session) => session.id === saved.sessionId)) {
        this.storage.forgetOpenTerm(saved.id);
        continue;
      }
      this.terms.set(saved.id, {
        id: saved.id,
        sessionId: saved.sessionId,
        kind: saved.kind,
        title: saved.title,
        remark: saved.remark,
        liveGen: 0
      });
      if (saved.scrollback) this.savedLines.set(saved.id, saved.scrollback);
      this.lastStatus.set(saved.id, {
        termId: saved.id,
        sessionId: saved.sessionId,
        status: "disconnected"
      });
    }
  }
  persist(term) {
    this.storage.saveOpenTerm({
      id: term.id,
      sessionId: term.sessionId,
      kind: term.kind,
      title: term.title,
      remark: term.remark,
      shell: term.shell
    });
  }
  arm(entry) {
    entry.liveGen += 1;
    return entry.liveGen;
  }
  alive(entry, gen) {
    return this.terms.get(entry.id) === entry && entry.liveGen === gen;
  }
  /** 只听这次拨号之后的状态，不把上次的失败当成这次的结果。 */
  waitNextStatus(termId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusListeners.delete(onStatus);
        reject(new Error("\u8FDE\u63A5\u8D85\u65F6"));
      }, timeoutMs);
      const onStatus = (event) => {
        if (event.termId !== termId) return;
        if (event.status === "connecting") return;
        clearTimeout(timer);
        this.statusListeners.delete(onStatus);
        if (event.status === "connected") resolve();
        else reject(new Error(event.error ?? "\u8FDE\u63A5\u5931\u8D25"));
      };
      this.statusListeners.add(onStatus);
    });
  }
  releaseLive(term) {
    if (!term) return;
    const channel = term.channel;
    const release = term.release;
    const client = term.client;
    const jump = term.jump;
    term.channel = void 0;
    term.release = void 0;
    term.client = void 0;
    term.jump = void 0;
    try {
      channel?.close();
      if (release) release();
      else client?.end();
      endJump(jump);
    } catch {
    }
  }
  push(termId, data) {
    const wc = this.getSender();
    if (!wc || wc.isDestroyed()) return;
    const payload = { termId, data };
    wc.send(IPC.termData, payload);
  }
  sendStatus(termId, sessionId, status, error) {
    const payload = { termId, sessionId, status, error };
    this.lastStatus.set(termId, payload);
    for (const listener of [...this.statusListeners]) listener(payload);
    const wc = this.getSender();
    if (!wc || wc.isDestroyed()) return;
    wc.send(IPC.termStatus, payload);
  }
};
function sshChannel(stream) {
  return {
    write: (data) => stream.write(data),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    close: () => {
      try {
        stream.close();
      } catch {
      }
    }
  };
}
function ptyChannel(proc) {
  return {
    write: (data) => proc.write(typeof data === "string" ? data : data.toString("utf8")),
    resize: (cols, rows) => proc.resize(cols, rows),
    close: () => {
      try {
        proc.kill();
      } catch {
      }
    }
  };
}
function lastScreenLine(raw) {
  const lines = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n").split("\n");
  return (lines.filter((line) => line.trim().length > 0).pop() ?? "").trim();
}
function isPromptAgain(last, before) {
  if (!last || last.length > 300) return false;
  if (before && last === before) return true;
  const tail = before.match(/[$#>%❯»]\s*$/)?.[0]?.trim();
  if (tail && last.endsWith(tail)) return true;
  return /[$#>%❯»]\s*$/.test(last);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isForwardDenied(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("\u8DF3\u677F\u65E0\u6CD5\u8F6C\u5230\u76EE\u6807\u673A");
}
var PWSH_EXE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
var GIT_BASH_EXE = "C:\\Program Files\\Git\\bin\\bash.exe";
var WSL_EXE = "C:\\Windows\\System32\\wsl.exe";
function findExe(name, pathHint, fallbacks) {
  try {
    const out = (0, import_node_child_process2.execFileSync)("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && pathHint.test(p)) return p;
    }
  } catch {
  }
  for (const candidate of fallbacks) if ((0, import_node_fs.existsSync)(candidate)) return candidate;
  return null;
}
function gitBashExe() {
  return findExe("bash.exe", /git/i, [GIT_BASH_EXE, "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]);
}
function pwshExe() {
  return findExe("pwsh.exe", /pwsh|powershell/i, [PWSH_EXE]);
}
function localShellExe(shell) {
  if (process.platform !== "win32") return process.env.SHELL || "/bin/bash";
  if (shell === "cmd") return "cmd.exe";
  if (shell === "pwsh") {
    const exe = pwshExe();
    if (exe) return exe;
  }
  if (shell === "gitbash") {
    const exe = gitBashExe();
    if (exe) return exe;
  }
  if (shell === "wsl" && (0, import_node_fs.existsSync)(WSL_EXE)) return WSL_EXE;
  return "powershell.exe";
}
function detectLocalShells() {
  if (process.platform !== "win32") {
    const exe = process.env.SHELL || "/bin/bash";
    return [{ id: "powershell", label: exe.split("/").pop() ?? "bash", exe }];
  }
  const shells = [
    { id: "powershell", label: "PowerShell", exe: "powershell.exe" },
    { id: "cmd", label: "CMD", exe: "cmd.exe" }
  ];
  const pwsh = pwshExe();
  if (pwsh) shells.push({ id: "pwsh", label: "PowerShell 7", exe: pwsh });
  const gitbash = gitBashExe();
  if (gitbash) shells.push({ id: "gitbash", label: "Git Bash", exe: gitbash });
  if ((0, import_node_fs.existsSync)(WSL_EXE)) shells.push({ id: "wsl", label: "WSL", exe: WSL_EXE });
  return shells;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TerminalService,
  detectLocalShells
});
