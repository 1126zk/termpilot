package sshx

import (
	"strings"
	"testing"
)

func TestParseBrowserInfo(t *testing.T) {
	noDocker := parseBrowserInfo(`
#TP-DOCKER#
no
#TP-RUNNING#
no
#TP-ERR#
sh: docker: command not found
#TP-STATE#
#TP-END#
`)
	if noDocker.DockerAvailable || noDocker.DockerRunning || noDocker.State != "" || noDocker.NeedSudo {
		t.Fatalf("no docker: %+v", noDocker)
	}

	noContainer := parseBrowserInfo(`
#TP-DOCKER#
yes
#TP-RUNNING#
yes
#TP-ERR#
#TP-STATE#
#TP-END#
`)
	if !noContainer.DockerAvailable || !noContainer.DockerRunning || noContainer.State != "" {
		t.Fatalf("docker up, browser missing: %+v", noContainer)
	}

	running := parseBrowserInfo(`
#TP-DOCKER#
yes
#TP-RUNNING#
yes
#TP-ERR#
#TP-STATE#
running
#TP-END#
`)
	if running.State != "running" {
		t.Fatalf("state = %q", running.State)
	}

	denied := parseBrowserInfo(`
#TP-DOCKER#
yes
#TP-RUNNING#
no
#TP-ERR#
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock
#TP-STATE#
#TP-END#
`)
	if !denied.DockerAvailable || !denied.NeedSudo || denied.State != "" {
		t.Fatalf("sudo: %+v", denied)
	}

	down := parseBrowserInfo(`
#TP-DOCKER#
yes
#TP-RUNNING#
no
#TP-ERR#
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
#TP-STATE#
#TP-END#
`)
	if !down.DockerAvailable || down.DockerRunning || down.NeedSudo || down.State != "" {
		t.Fatalf("daemon down must not look like a missing browser: %+v", down)
	}
}

func TestBrowserInstallScriptBindsLoopback(t *testing.T) {
	if !strings.Contains(browserInstallScript, "--remote-debugging-address=127.0.0.1") {
		t.Fatal("CDP must bind loopback")
	}
	if !strings.Contains(browserInstallScript, browserContainer) || !strings.Contains(browserInstallScript, browserImage) {
		t.Fatal("container or image name missing")
	}
	if strings.Contains(browserInstallScript, "-p 127.0.0.1") || strings.Contains(browserInstallScript, "-p 9222") {
		t.Fatal("host network does not publish 9222")
	}
}

func TestBrowserCacheScriptKeepsImages(t *testing.T) {
	if strings.Contains(browserClearCacheScript, "rm -rf /var/lib/docker\n") || strings.Contains(browserClearCacheScript, "docker system prune") {
		t.Fatal("clear cache must not wipe docker")
	}
	if !strings.Contains(browserClearCacheScript, "/ingest") || !strings.Contains(browserClearCacheScript, "/var/lib/docker/tmp") {
		t.Fatal("clear cache should remove unfinished downloads")
	}
	if !strings.Contains(browserStopPullScript, "docker pull chromedp/headless-shell") {
		t.Fatal("pause should stop the image pull")
	}
}
