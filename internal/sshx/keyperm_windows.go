//go:build windows

package sshx

import (
	"fmt"
	"runtime"

	"golang.org/x/sys/windows"
)

// restrictPrivateKey 把私钥的访问收成只有当前用户。
// Windows 的 OpenSSH 看到别人也能读的私钥会直接拒绝。
func restrictPrivateKey(path string) error {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return fmt.Errorf("收紧私钥权限失败：%w", err)
	}
	sid, err := windows.StringToSid(user.User.Sid.String())
	if err != nil {
		return fmt.Errorf("收紧私钥权限失败：%w", err)
	}
	var pinner runtime.Pinner
	pinner.Pin(sid)
	defer pinner.Unpin()

	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_READ | windows.GENERIC_WRITE,
		AccessMode:        windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}}, nil)
	if err != nil {
		return fmt.Errorf("收紧私钥权限失败：%w", err)
	}
	err = windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		acl,
		nil,
	)
	if err != nil {
		return fmt.Errorf("收紧私钥权限失败：%w", err)
	}
	return nil
}
