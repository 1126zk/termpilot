package app

import (
	"os"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"termpilot/internal/sshx"
)

func (a *App) hSshKeyGenerate(_ []interface{}) (interface{}, error) {
	dir, err := sshx.UserSSHDir()
	if err != nil {
		return nil, err
	}
	return sshx.GenerateKeyPair(dir)
}

func (a *App) hSshKeyImportPrivate(_ []interface{}) (interface{}, error) {
	picked, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "选择私钥文件",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "私钥 (*.pem, *.key)", Pattern: "*.pem;*.key"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return nil, nil
	}
	dir, err := sshx.UserSSHDir()
	if err != nil {
		return nil, err
	}
	return sshx.ImportPrivateKey(dir, picked)
}

func (a *App) hSshKeyInstallPublic(args []interface{}) (interface{}, error) {
	id, err := argStr(args, 0)
	if err != nil {
		return nil, err
	}
	pub, err := argStr(args, 1)
	if err != nil {
		return nil, err
	}
	return a.exec.InstallAuthorizedKey(id, pub)
}

func (a *App) hSshKeyReadPublicFile(_ []interface{}) (interface{}, error) {
	opts := wailsRuntime.OpenDialogOptions{
		Title: "选择公钥文件",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "公钥 (*.pub)", Pattern: "*.pub"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	}
	if dir, err := sshx.UserSSHDir(); err == nil {
		if info, statErr := os.Stat(dir); statErr == nil && info.IsDir() {
			opts.DefaultDirectory = dir
		}
	}
	picked, err := wailsRuntime.OpenFileDialog(a.ctx, opts)
	if err != nil {
		return nil, err
	}
	if picked == "" {
		return nil, nil
	}
	return sshx.ReadPublicKeyFile(picked)
}
