package sshx

import (
	"strings"
	"testing"
)

func TestDockerNeedsSudo(t *testing.T) {
	denied := "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
	if !dockerNeedsSudo(denied) {
		t.Fatal("sock permission denied should need sudo")
	}
	down := "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
	if dockerNeedsSudo(down) {
		t.Fatal("daemon down is not a sudo problem")
	}
}

func TestSudoRejected(t *testing.T) {
	if !sudoRejected("Sorry, try again.") {
		t.Fatal("wrong password")
	}
	if sudoRejected("permission denied while trying to connect to the Docker daemon socket") {
		t.Fatal("socket denial is not a bad sudo password")
	}
}

func TestDockerCollectScriptHidesPassword(t *testing.T) {
	const password = "p@ss'word"
	script := dockerCollectScript(password)
	if strings.Contains(script, password) {
		t.Fatal("script contains the raw password")
	}
	if !strings.Contains(script, "sudo -S -p '' docker") {
		t.Fatal("sudo wrapper missing")
	}
	plain := dockerCollectScript("")
	if strings.Contains(plain, "sudo") {
		t.Fatal("empty password should stay on plain docker")
	}
}
