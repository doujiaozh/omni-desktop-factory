package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// assetsFS holds the entire frontend (the --src directory) compiled INTO the
// binary via go:embed. `all:` keeps files that start with "." or "_" (we ship
// __omni.js there). Zero disk IO at runtime: one .exe is the whole app.
//
//go:embed all:assets
var assetsFS embed.FS

// bridgeFS holds the frontend RPC SDK. It is served at /__omni.js so every
// generated app gets window.omni without the developer adding a file.
//
//go:embed bridge/omni.js
var bridgeFS embed.FS

func main() {
	cfg := loadConfig()

	log.SetFlags(log.LstdFlags)
	log.SetPrefix(fmt.Sprintf("[%s] ", safeName(cfg.Name)))

	// The production build links with -H windowsgui, so there is no console to
	// read stderr from. Mirror the log into %TMP%/omni-<name>.log so support
	// sessions always have something to read.
	if f, err := os.OpenFile(
		filepath.Join(os.TempDir(), "omni-"+safeName(cfg.Name)+".log"),
		os.O_CREATE|os.O_WRONLY|os.O_TRUNC,
		0o644,
	); err == nil {
		log.SetOutput(f)
	}

	if err := run(context.Background(), cfg); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}
