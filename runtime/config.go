package main

// AppConfig holds build-time configuration injected by omni-desktop-factory.
//
// THIS FILE IS A TEMPLATE. The Node side (src/generate.js) rewrites the
// "__OMNI_*" placeholders and the Width/Height numbers when it scaffolds a
// build, so every generated binary carries its own title, size and host
// choice without any runtime config file.

// AppConfig describes the generated application.
type AppConfig struct {
	Name      string // binary/product name
	Title     string // exposed to the frontend via system.getInfo
	Version   string // reported by system.getInfo / bridge.version
	Width     int    // initial window width in pixels
	Height    int    // initial window height in pixels
	Browser   string // window host preference: auto | chrome | edge | ... | default
	IndexFile string // entry document inside the embedded assets
}

func loadConfig() AppConfig {
	return AppConfig{
		Name:      "__OMNI_NAME__",
		Title:     "__OMNI_TITLE__",
		Version:   "__OMNI_VERSION__",
		Width:     1200,
		Height:    800,
		Browser:   "__OMNI_BROWSER__",
		IndexFile: "index.html",
	}
}
