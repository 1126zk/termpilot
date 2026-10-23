package app

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"termpilot/internal/sftpx"
	"termpilot/internal/storage"
	"termpilot/internal/terminal"
)

// 本文件是全部 IPC 通道的 handler，channel 与 shared/ipc-channels.ts 一一对应。

// ------------------------------------------------------------ 会话

func (a *App) hSessionCreate(args []interface{}) (interface{}, error) {
	input, err := arg[storage.SessionInput](args, 0)
	if err != nil {
		return nil, err
	}
	return a.store.Create(&input)
}

func (a *App) hSessionUpdate(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	patch, err := arg[storage.SessionInput](args, 1)
	if err != nil {
		return nil, err
	}
	return a.store.Update(id, &patch)
}

func (a *App) hSessionDelete(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	a.sftp.Close(id)
	return a.store.Delete(id)
}

func (a *App) hSessionDuplicate(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.store.Duplicate(id)
}

func (a *App) hSessionDetectOs(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.exec.DetectOS(id), nil
}

func (a *App) hSessionMetrics(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.exec.CollectMetrics(id)
}

func (a *App) hSessionServerInfo(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.exec.CollectServerInfo(id)
}

func (a *App) hSessionKillProc(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	pid, err := arg[int](args, 1)
	if err != nil {
		return nil, err
	}
	return nil, a.exec.KillProcess(id, pid)
}

func (a *App) hSessionDocker(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.exec.CollectDocker(id)
}

func (a *App) hSessionDockerAction(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	action, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	target, err := argStr(args, 2)
	if err != nil {
		return nil, err
	}
	name, _ := argStr(args, 3) // save 导出文件名用，可空
	return a.exec.DockerAction(id, action, target, name)
}

func (a *App) hSessionWeb(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.exec.CollectWeb(id)
}

func (a *App) hSessionWebInstall(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	name, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	return nil, a.exec.WebInstall(id, name)
}

func (a *App) hSessionWebSite(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	service, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	action, err := argStr(args, 2)
	if err != nil {
		return nil, err
	}
	domain, err := argStr(args, 3)
	if err != nil {
		return nil, err
	}
	siteType, _ := argStr(args, 4) // del 时为空
	target, _ := argStr(args, 5)
	return nil, a.exec.WebSite(id, service, action, domain, siteType, target)
}

func (a *App) hSessionSetOs(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	osName, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	return nil, a.store.SetOs(id, osName)
}

func (a *App) hSessionRevealSecret(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	secret, err := a.store.GetSecret(id)
	if err != nil {
		return nil, err
	}
	if secret == "" {
		return nil, nil
	}
	return secret, nil
}

func (a *App) hHostNoteSet(args []interface{}) (interface{}, error) {
	hostKey, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	remark, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	return a.store.SetHostNote(hostKey, remark)
}

func (a *App) hShellsList(_ []interface{}) (interface{}, error) {
	return terminal.DetectLocalShells(), nil
}

// ------------------------------------------------------------ 终端

func (a *App) hTermCreate(args []interface{}) (interface{}, error) {
	opts, err := arg[terminal.CreateOptions](args, 0)
	if err != nil {
		return nil, err
	}
	a.terminal.Create(opts)
	return nil, nil
}

func (a *App) hTermCwd(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	cwd := a.terminal.CwdOf(termID)
	if cwd == "" {
		return nil, nil
	}
	return cwd, nil
}

func (a *App) hTermBindView(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	a.terminal.BindView(termID)
	return nil, nil
}

func (a *App) hTermInput(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	data, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	a.terminal.Input(termID, data)
	return nil, nil
}

func (a *App) hTermResize(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	cols, err := arg[int](args, 1)
	if err != nil {
		return nil, err
	}
	rows, err := arg[int](args, 2)
	if err != nil {
		return nil, err
	}
	a.terminal.Resize(termID, cols, rows)
	return nil, nil
}

func (a *App) hTermClose(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	a.terminal.Close(termID)
	return nil, nil
}

func (a *App) hTermLabel(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	body, err := arg[map[string]interface{}](args, 1)
	if err != nil {
		return nil, err
	}
	patch := terminal.LabelPatch{}
	if v, ok := body["title"].(string); ok {
		patch.Title = &v
	}
	if v, ok := body["remark"].(string); ok {
		patch.Remark = &v
	}
	a.terminal.SetLabel(termID, patch)
	return nil, nil
}

// ------------------------------------------------------------ SFTP

func (a *App) hSftpList(args []interface{}) (interface{}, error) {
	sessionID, dir, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	path, entries, err := a.sftp.List(sessionID, dir)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"path": path, "entries": entries}, nil
}

func (a *App) hSftpMkdir(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	dir, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	name, err := argStr(args, 2)
	if err != nil {
		return nil, err
	}
	return nil, a.sftp.Mkdir(sessionID, dir, name)
}

func (a *App) hSftpRemove(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	path, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	kind, err := arg[sftpx.FileKind](args, 2)
	if err != nil {
		return nil, err
	}
	return nil, a.sftp.Remove(sessionID, path, kind)
}

func (a *App) hSftpRename(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	from, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	to, err := argStr(args, 2)
	if err != nil {
		return nil, err
	}
	return nil, a.sftp.Rename(sessionID, from, to)
}

func (a *App) hSftpUpload(args []interface{}) (interface{}, error) {
	sessionID, dir, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "选择要上传的文件"})
	if err != nil {
		return nil, err
	}
	if len(picked) == 0 {
		return 0, nil
	}
	return a.sftp.UploadPaths(sessionID, dir, picked)
}

func (a *App) hSftpUploadDir(args []interface{}) (interface{}, error) {
	sessionID, dir, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "选择要上传的文件夹"})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return 0, nil
	}
	return a.sftp.UploadPaths(sessionID, dir, []string{picked})
}

func (a *App) hSftpUploadPaths(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	dir, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	paths, err := arg[[]string](args, 2)
	if err != nil {
		return nil, err
	}
	return a.sftp.UploadPaths(sessionID, dir, paths)
}

func (a *App) hSftpDownload(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	file, err := arg[sftpx.RemoteFile](args, 1)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:           "下载到",
		DefaultFilename: file.Name,
	})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return false, nil
	}
	if err := a.sftp.Download(sessionID, file, picked); err != nil {
		return nil, err
	}
	return true, nil
}

func (a *App) hSftpDownloadDir(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	file, err := arg[sftpx.RemoteFile](args, 1)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "下载到哪个文件夹"})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return false, nil
	}
	if err := a.sftp.DownloadDir(sessionID, file, picked); err != nil {
		return nil, err
	}
	return true, nil
}

func (a *App) hSftpRead(args []interface{}) (interface{}, error) {
	sessionID, path, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	return a.sftp.ReadText(sessionID, path)
}

func (a *App) hSftpReadImage(args []interface{}) (interface{}, error) {
	sessionID, path, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	return a.sftp.ReadImage(sessionID, path)
}

func (a *App) hSftpWrite(args []interface{}) (interface{}, error) {
	sessionID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	path, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	text, err := argStr(args, 2)
	if err != nil {
		return nil, err
	}
	return nil, a.sftp.WriteText(sessionID, path, text)
}

func (a *App) hSftpTransferCancel(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	a.sftp.CancelTransfer(id)
	return nil, nil
}

// ------------------------------------------------------------ 本机文件

func (a *App) hLocalList(args []interface{}) (interface{}, error) {
	dir, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.local.List(dir)
}

func (a *App) hLocalMkdir(args []interface{}) (interface{}, error) {
	dir, name, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	return nil, a.local.Mkdir(dir, name)
}

func (a *App) hLocalRemove(args []interface{}) (interface{}, error) {
	path, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	kind, err := arg[sftpx.FileKind](args, 1)
	if err != nil {
		return nil, err
	}
	return nil, a.local.Remove(path, kind)
}

func (a *App) hLocalRename(args []interface{}) (interface{}, error) {
	from, to, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	return nil, a.local.Rename(from, to)
}

func (a *App) hLocalUpload(args []interface{}) (interface{}, error) {
	dir, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "选择文件"})
	if err != nil {
		return nil, err
	}
	if len(picked) == 0 {
		return 0, nil
	}
	return a.local.UploadPaths(dir, picked)
}

func (a *App) hLocalUploadDir(args []interface{}) (interface{}, error) {
	dir, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "选择文件夹"})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return 0, nil
	}
	return a.local.UploadPaths(dir, []string{picked})
}

func (a *App) hLocalUploadPaths(args []interface{}) (interface{}, error) {
	dir, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	paths, err := arg[[]string](args, 1)
	if err != nil {
		return nil, err
	}
	return a.local.UploadPaths(dir, paths)
}

func (a *App) hLocalMovePaths(args []interface{}) (interface{}, error) {
	dir, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	paths, err := arg[[]string](args, 1)
	if err != nil {
		return nil, err
	}
	return a.local.MoveInto(dir, paths)
}

func (a *App) hLocalDragMove(args []interface{}) (interface{}, error) {
	paths, err := arg[[]string](args, 0)
	if err != nil {
		return nil, err
	}
	return nil, a.local.DragMove(paths)
}

func (a *App) hLocalDownload(args []interface{}) (interface{}, error) {
	file, err := arg[sftpx.RemoteFile](args, 0)
	if err != nil {
		return nil, err
	}
	if file.Kind == sftpx.KindDir {
		return nil, errors.New("先进入目录再下载里面的文件")
	}
	picked, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:           "另存为",
		DefaultFilename: file.Name,
	})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return false, nil
	}
	if err := a.local.CopyTo(file.Path, picked); err != nil {
		return nil, err
	}
	return true, nil
}

func (a *App) hLocalDownloadDir(args []interface{}) (interface{}, error) {
	file, err := arg[sftpx.RemoteFile](args, 0)
	if err != nil {
		return nil, err
	}
	if file.Kind != sftpx.KindDir {
		return nil, errors.New("只能下载目录")
	}
	picked, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "下载到哪个文件夹"})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return false, nil
	}
	if err := a.local.CopyTo(file.Path, joinPath(picked, file.Name)); err != nil {
		return nil, err
	}
	return true, nil
}

func (a *App) hLocalRead(args []interface{}) (interface{}, error) {
	path, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.local.ReadText(path)
}

func (a *App) hLocalReadImage(args []interface{}) (interface{}, error) {
	path, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.local.ReadImage(path)
}

func (a *App) hLocalWrite(args []interface{}) (interface{}, error) {
	path, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	text, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	return nil, a.local.WriteText(path, text)
}

// ------------------------------------------------------------ 片段 / 历史

func (a *App) hSnippetCreate(args []interface{}) (interface{}, error) {
	name, command, err := twoStrings(args)
	if err != nil {
		return nil, err
	}
	return a.store.CreateSnippet(name, command)
}

func (a *App) hSnippetUpdate(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	name, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	command, err := argStr(args, 2)
	if err != nil {
		return nil, err
	}
	return nil, a.store.UpdateSnippet(id, name, command)
}

func (a *App) hSnippetDelete(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return nil, a.store.DeleteSnippet(id)
}

func (a *App) hHistoryList(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return a.store.ListHistory(termID)
}

func (a *App) hHistoryClear(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	return nil, a.store.ClearHistory(termID)
}

// ------------------------------------------------------------ 外观 / MCP

func (a *App) hAppearanceSave(args []interface{}) (interface{}, error) {
	input, err := arg[storage.Appearance](args, 0)
	if err != nil {
		return nil, err
	}
	// Electron 版这里会按主题重设窗口底色；Wails v2 运行期改不了窗口底色，
	// 重启后生效（记录在计划文档偏差项）。
	return a.store.SaveAppearance(input)
}

func (a *App) hMcpAudit(_ []interface{}) (interface{}, error) {
	return a.store.ListAudit(0)
}

func (a *App) hMcpAuditExport(_ []interface{}) (interface{}, error) {
	entries, err := a.store.ListAudit(0)
	if err != nil {
		return nil, err
	}
	picked, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:           "导出调用记录",
		DefaultFilename: fmt.Sprintf("termpilot-audit-%s.log", time.Now().Format("20060102-150405")),
	})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return false, nil
	}
	if err := os.WriteFile(picked, []byte(formatMcpAudit(entries)), 0o600); err != nil {
		return nil, err
	}
	return true, nil
}

func formatMcpAudit(entries []storage.McpAuditEntry) string {
	var out strings.Builder
	for _, entry := range entries {
		status := "失败"
		if entry.Ok {
			status = "成功"
		}
		fmt.Fprintf(&out, "%s %s %s", time.UnixMilli(entry.At).Local().Format("2006/01/02 15:04:05"), status, entry.Tool)
		if entry.Detail != "" {
			fmt.Fprintf(&out, " %s", entry.Detail)
		}
		out.WriteByte('\n')
	}
	return out.String()
}

func (a *App) hMcpSave(args []interface{}) (interface{}, error) {
	input, err := arg[storage.McpSettingsInput](args, 0)
	if err != nil {
		return nil, err
	}
	settings, err := a.store.SaveMcpSettings(&input)
	if err != nil {
		return nil, err
	}
	if err := a.mcp.Apply(*settings); err != nil {
		return nil, err
	}
	return settings, nil
}

func (a *App) hMcpBound(args []interface{}) (interface{}, error) {
	termID, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	a.terminal.MarkBound(termID)
	return nil, nil
}

// ------------------------------------------------------------ 窗口

func (a *App) hWinMinimize(_ []interface{}) (interface{}, error) {
	wailsRuntime.WindowMinimise(a.ctx)
	return nil, nil
}

func (a *App) hWinToggleMaximize(_ []interface{}) (interface{}, error) {
	wailsRuntime.WindowToggleMaximise(a.ctx)
	return nil, nil
}

func (a *App) hWinClose(_ []interface{}) (interface{}, error) {
	wailsRuntime.Quit(a.ctx)
	return nil, nil
}

func (a *App) hWinIsMaximized(_ []interface{}) (interface{}, error) {
	return wailsRuntime.WindowIsMaximised(a.ctx), nil
}

// hWinNew 再启动一份程序，成为另一扇窗口。主机列表仍是同一份数据库。
func (a *App) hWinNew(_ []interface{}) (interface{}, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	args := []string{"--extra-window"}
	if a.ctx != nil && !wailsRuntime.WindowIsMaximised(a.ctx) {
		x, y := wailsRuntime.WindowGetPosition(a.ctx)
		args = append(args, "--pos", strconv.Itoa(x+32), strconv.Itoa(y+32))
	}
	if err := startDetached(exe, args...); err != nil {
		return nil, err
	}
	return nil, nil
}

// ------------------------------------------------------------ 小工具

func twoStrings(args []interface{}) (string, string, error) {
	first, err := argStr(args, 0)
	if err != nil {
		return "", "", err
	}
	second, err := argStr(args, 1)
	if err != nil {
		return "", "", err
	}
	return first, second, nil
}
