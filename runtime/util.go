package main

import (
	"io/fs"
	"os"
	"strings"
)

// fileExists reports whether p exists and is a regular file.
func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// safeName turns an arbitrary product name into something safe for file
// names, log file names and browser profile directories.
func safeName(s string) string {
	r := strings.NewReplacer(
		" ", "-", "\\", "-", "/", "-", ":", "-", "|", "-",
		"*", "", "?", "", "\"", "", "<", "", ">", "",
	)
	out := strings.ToLower(r.Replace(strings.TrimSpace(s)))
	if out == "" {
		out = "omni-app"
	}
	return out
}

// uniqueStrings de-duplicates a string slice preserving order.
func uniqueStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// countEmbeddedFiles counts the files baked into the binary by go:embed.
func countEmbeddedFiles() int {
	n := 0
	_ = fs.WalkDir(assetsFS, "assets", func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}
