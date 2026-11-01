package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// The "webview" strategy of omni-desktop-factory, on purpose, is NOT a C++
// webview2/MSHTML binding (that needs CGO). We launch a real browser in
// "--app" mode: a dedicated, nearly chrome-less window pointing at the
// embedded 127.0.0.1 server. Pure Go, zero C toolchain, and it still feels
// like a native app (own window, own taskbar entry, own profile).

type browserCandidate struct {
	Name string
	Path string
	Kind string // "chromium" | "firefox"
}

func windowsProgramDirs() []string {
	var dirs []string
	for _, env := range []string{"PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"} {
		if v := os.Getenv(env); v != "" {
			dirs = append(dirs, v)
		}
	}
	return uniqueStrings(dirs)
}

func candidateBrowsers() []browserCandidate {
	var list []browserCandidate
	switch runtime.GOOS {
	case "windows":
		dirs := windowsProgramDirs()
		chromiumBins := []struct{ name, rel string }{
			{"chrome", `Google\Chrome\Application\chrome.exe`},
			{"edge", `Microsoft\Edge\Application\msedge.exe`},
			{"chromium", `Chromium\Application\chrome.exe`},
			{"brave", `BraveSoftware\Brave-Browser\Application\brave.exe`},
			{"vivaldi", `Vivaldi\Application\vivaldi.exe`},
			{"opera", `Opera\opera.exe`},
		}
		for _, b := range chromiumBins {
			for _, d := range dirs {
				p := filepath.Join(d, b.rel)
				if fileExists(p) {
					list = append(list, browserCandidate{Name: b.name, Path: p, Kind: "chromium"})
					break
				}
			}
		}
		for _, d := range dirs {
			p := filepath.Join(d, `Mozilla Firefox\firefox.exe`)
			if fileExists(p) {
				list = append(list, browserCandidate{Name: "firefox", Path: p, Kind: "firefox"})
				break
			}
		}
	case "darwin":
		chromeP := `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
		if fileExists(chromeP) {
			list = append(list, browserCandidate{Name: "chrome", Path: chromeP, Kind: "chromium"})
		}
		ffP := `/Applications/Firefox.app/Contents/MacOS/firefox`
		if fileExists(ffP) {
			list = append(list, browserCandidate{Name: "firefox", Path: ffP, Kind: "firefox"})
		}
	default: // linux and friends
		for _, p := range []string{
			"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
			"/usr/bin/chromium", "/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge", "/usr/bin/firefox",
		} {
			if fileExists(p) {
				kind := "chromium"
				if strings.Contains(p, "firefox") {
					kind = "firefox"
				}
				list = append(list, browserCandidate{Name: filepath.Base(p), Path: p, Kind: kind})
			}
		}
	}
	return list
}

func findBrowser(preferred string) (*browserCandidate, error) {
	cands := candidateBrowsers()
	preferred = strings.ToLower(strings.TrimSpace(preferred))

	if preferred == "" || preferred == "auto" {
		if len(cands) == 0 {
			return nil, fmt.Errorf("no supported browser found (run omni-factory doctor)")
		}
		return &cands[0], nil
	}

	for i := range cands {
		c := cands[i]
		if strings.Contains(strings.ToLower(c.Name), preferred) ||
			strings.Contains(strings.ToLower(filepath.Base(c.Path)), preferred) {
			return &cands[i], nil
		}
	}
	if fileExists(preferred) {
		kind := "chromium"
		if strings.Contains(strings.ToLower(preferred), "firefox") {
			kind = "firefox"
		}
		return &browserCandidate{Name: filepath.Base(preferred), Path: preferred, Kind: kind}, nil
	}
	return nil, fmt.Errorf("browser %q not found (detected: %v)", preferred, browserNames(cands))
}

func browserNames(cands []browserCandidate) string {
	names := make([]string, 0, len(cands))
	for _, c := range cands {
		names = append(names, c.Name)
	}
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, ", ")
}

// window is the launched app window process.
type window struct {
	cmd  *exec.Cmd
	name string
}

func (w *window) pid() int {
	if w == nil || w.cmd == nil || w.cmd.Process == nil {
		return 0
	}
	return w.cmd.Process.Pid
}

func (w *window) Wait() error {
	if w == nil || w.cmd == nil {
		return nil
	}
	return w.cmd.Wait()
}

// Close kills the window host process if it is still running.
func (w *window) Close() error {
	if w == nil || w.cmd == nil || w.cmd.Process == nil {
		return nil
	}
	if w.cmd.ProcessState != nil {
		return nil // already exited
	}
	return w.cmd.Process.Kill()
}

// launchWindow opens the app URL in a borderless-ish browser window.
func launchWindow(cfg AppConfig, url string) (*window, error) {
	bc, err := findBrowser(cfg.Browser)
	if err != nil {
		return nil, err
	}

	var args []string
	if bc.Kind == "chromium" {
		// A dedicated profile keeps the app window isolated from the user's
		// normal browser session and makes the window process exit when the
		// app window is closed.
		profileDir := filepath.Join(os.TempDir(), "omni-"+safeName(cfg.Name)+"-profile")
		args = []string{
			"--app=" + url,
			"--window-size=" + strconv.Itoa(cfg.Width) + "," + strconv.Itoa(cfg.Height),
			"--user-data-dir=" + profileDir,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			"--disable-background-mode",
			"--disable-features=Translate",
			"--autoplay-policy=no-user-gesture-required",
		}
	} else {
		// Firefox has no --app mode; a plain window is the best we can do.
		args = []string{url}
	}

	cmd := exec.Command(bc.Path, args...)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("launch %s: %w", bc.Name, err)
	}
	return &window{cmd: cmd, name: bc.Name}, nil
}

// openDefault opens url in the system's default browser.
func openDefault(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("cmd", "/c", "start", "", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
