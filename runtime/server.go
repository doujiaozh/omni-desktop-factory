package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// exitCh lets any goroutine (RPC handler, signal handler, window watcher)
// request a clean shutdown of the whole app.
var exitCh = make(chan struct{})

func triggerExit() {
	select {
	case exitCh <- struct{}{}:
	default:
	}
}

// run is the app lifecycle: start the embedded-asset server, open the app
// window, then block until something asks us to quit.
func run(ctx context.Context, cfg AppConfig) error {
	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		return fmt.Errorf("prepare embedded assets: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/__omni_ws", serveWS(cfg))
	mux.HandleFunc("/__omni/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok": true, "name": cfg.Name, "version": cfg.Version,
		})
	})
	// The frontend bridge SDK, served at a fixed path so every generated app
	// can <script src="/__omni.js"> without knowing its own layout.
	if sdkBytes, err := fs.ReadFile(bridgeFS, "bridge/omni.js"); err == nil {
		mux.HandleFunc("/__omni.js", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(sdkBytes)
		})
	}
	mux.Handle("/", http.FileServer(http.FS(spaFS{root: sub, index: cfg.IndexFile})))

	addr := "127.0.0.1:0"
	if p := strings.TrimSpace(os.Getenv("OMNI_PORT")); p != "" {
		addr = "127.0.0.1:" + p // debug hook: force a fixed port
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on loopback: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	appURL := fmt.Sprintf("http://127.0.0.1:%d/", port)
	if cfg.IndexFile != "" && cfg.IndexFile != "index.html" {
		appURL += cfg.IndexFile
	}
	log.Printf("omni runtime %s: %d embedded files at %s", cfg.Version, countEmbeddedFiles(), appURL)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	// OMNI_NO_WINDOW=1 skips the window host entirely: the embedded server
	// still runs, which is how CI and smoke tests verify a generated app.
	var win *window
	if strings.TrimSpace(os.Getenv("OMNI_NO_WINDOW")) == "1" {
		log.Printf("OMNI_NO_WINDOW=1: running headless on %s (Ctrl+C to exit)", appURL)
	} else {
		// Bring up the window host (browser in --app mode by default).
		var launchErr error
		win, launchErr = launchWindow(cfg, appURL)
		if launchErr != nil {
			log.Printf("warning: window host unavailable: %v", launchErr)
			if err := openDefault(appURL); err != nil {
				log.Printf("warning: system browser failed too: %v", err)
			}
			log.Printf("running headless on %s (Ctrl+C to exit)", appURL)
		} else {
			log.Printf("window host: %s (pid %d)", win.name, win.pid())
			go func() {
				_ = win.Wait()
				log.Printf("app window closed")
				triggerExit()
			}()
		}
	}

	serverErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Printf("shutdown signal received")
	case <-exitCh:
		log.Printf("exit requested")
	case err := <-serverErr:
		if win != nil {
			_ = win.Close()
		}
		return fmt.Errorf("http server: %w", err)
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	if win != nil {
		_ = win.Close()
	}
	return nil
}

// writeJSON is the tiny helper used by the non-websocket endpoints.
func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// spaFS wraps the embedded assets so that client-side routes (e.g. /about)
// resolve to index.html while true 404s like /favicon.ico stay 404s.
type spaFS struct {
	root  fs.FS
	index string
}

func (f spaFS) Open(name string) (fs.File, error) {
	file, err := f.root.Open(name)
	if err == nil {
		return file, nil
	}
	if errors.Is(err, fs.ErrNotExist) && !strings.Contains(pathBase(name), ".") {
		if idx, err2 := f.root.Open(f.index); err2 == nil {
			return idx, nil
		}
	}
	return nil, err
}

func pathBase(name string) string {
	// net/http always passes a path with the leading slash already stripped,
	// but be defensive about both shapes.
	name = strings.TrimPrefix(name, "/")
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	return name
}
