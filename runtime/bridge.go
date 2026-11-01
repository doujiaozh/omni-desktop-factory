package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

// =============================================================================
// factory_bridge — the RPC contract between the web frontend and the Go host.
//
// Wire format (JSON, one text frame per message):
//
//   call   (frontend -> Go):  {"type":"call","id":1,"method":"system.getInfo","params":{}}
//   result (Go -> frontend):  {"type":"result","id":1,"ok":true,"data":{...}}
//                             {"type":"result","id":1,"ok":false,"error":"..."}
//   event  (Go -> frontend):  {"type":"event","event":"omni:ready","data":{...}}
//
// Made for window.omni.call("system.getInfo") on the page side.
// =============================================================================

type rpcHandler func(ctx context.Context, params json.RawMessage) (interface{}, error)

type rpcWireIn struct {
	ID     json.RawMessage `json:"id"`
	Type   string          `json:"type"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcResult struct {
	ID   interface{} `json:"id"`
	Type string      `json:"type"`
	OK   bool        `json:"ok"`
	Data interface{} `json:"data,omitempty"`
	Err  string      `json:"error,omitempty"`
}

type rpcEvent struct {
	Type string      `json:"type"`
	Name string      `json:"event"`
	Data interface{} `json:"data,omitempty"`
}

// Bridge is one live frontend <-> Go connection.
type Bridge struct {
	cfg       AppConfig
	conn      *wsConn
	send      chan []byte
	handlers  map[string]rpcHandler
	startedAt time.Time
	done      chan struct{}
}

func newBridge(cfg AppConfig, conn *wsConn) *Bridge {
	b := &Bridge{
		cfg:       cfg,
		conn:      conn,
		send:      make(chan []byte, 64),
		handlers:  make(map[string]rpcHandler),
		startedAt: time.Now(),
		done:      make(chan struct{}),
	}
	b.register("system.getInfo", b.systemGetInfo)
	b.register("system.open", b.systemOpen)
	b.register("system.log", b.systemLog)
	b.register("app.exit", b.appExit)
	b.register("bridge.version", b.bridgeVersion)
	b.register("bridge.echo", b.bridgeEcho)
	return b
}

func (b *Bridge) register(method string, h rpcHandler) {
	b.handlers[method] = h
}

func (b *Bridge) handle(ctx context.Context, raw []byte) {
	var in rpcWireIn
	if err := json.Unmarshal(raw, &in); err != nil {
		b.reply(nil, nil, fmt.Errorf("malformed rpc message: %w", err))
		return
	}
	if in.Type != "call" || in.Method == "" {
		return // ignore non-call frames (frontend -> host events)
	}
	h, ok := b.handlers[in.Method]
	if !ok {
		b.reply(in.ID, nil, fmt.Errorf("unknown method: %s", in.Method))
		return
	}
	data, err := h(ctx, in.Params)
	b.reply(in.ID, data, err)
}

func (b *Bridge) reply(id json.RawMessage, data interface{}, err error) {
	var idVal interface{}
	if len(id) > 0 {
		_ = json.Unmarshal(id, &idVal)
	}
	res := rpcResult{ID: idVal, Type: "result", OK: err == nil}
	if err != nil {
		res.Err = err.Error()
	} else {
		res.Data = data
	}
	payload, jerr := json.Marshal(res)
	if jerr != nil {
		return
	}
	select {
	case b.send <- payload:
	default:
		log.Printf("rpc: reply queue full, dropping reply for %v", idVal)
	}
}

// emit pushes a host-side event to the page (omni.on("name") receives it).
func (b *Bridge) emit(name string, data interface{}) {
	payload, err := json.Marshal(rpcEvent{Type: "event", Name: name, Data: data})
	if err != nil {
		return
	}
	select {
	case b.send <- payload:
	default:
	}
}

// writeLoop drains the send queue and sends websocket pings to keep the
// connection alive through proxies.
func (b *Bridge) writeLoop(ctx context.Context) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.done:
			return
		case payload := <-b.send:
			if err := b.conn.writeText(payload); err != nil {
				return
			}
		case <-ticker.C:
			if err := b.conn.writeFrame(0x9, []byte("omni")); err != nil {
				return
			}
		}
	}
}

// serveWS is the http.Handler bound to /__omni_ws.
func serveWS(cfg AppConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrade(w, r)
		if err != nil {
			http.Error(w, "websocket upgrade failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer func() { _ = conn.close() }()

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		b := newBridge(cfg, conn)
		go b.writeLoop(ctx)
		b.emit("omni:ready", map[string]interface{}{
			"name": cfg.Name, "version": cfg.Version, "rpc": "1.0.0",
		})

		for {
			opcode, payload, err := conn.readMessage()
			if err != nil {
				break
			}
			if opcode == 0x8 {
				break // client closed gracefully
			}
			b.handle(ctx, payload)
		}
		close(b.done)
	}
}

// -----------------------------------------------------------------------------
// built-in RPC methods
// -----------------------------------------------------------------------------

func (b *Bridge) systemGetInfo(_ context.Context, _ json.RawMessage) (interface{}, error) {
	host, _ := os.Hostname()
	exe, _ := os.Executable()
	return map[string]interface{}{
		"name":          b.cfg.Name,
		"title":         b.cfg.Title,
		"version":       b.cfg.Version,
		"goVersion":     runtime.Version(),
		"os":            runtime.GOOS,
		"arch":          runtime.GOARCH,
		"hostname":      host,
		"pid":           os.Getpid(),
		"exePath":       exe,
		"uptimeSeconds": time.Since(b.startedAt).Seconds(),
		"embeddedFiles": countEmbeddedFiles(),
	}, nil
}

func (b *Bridge) systemOpen(_ context.Context, params json.RawMessage) (interface{}, error) {
	var p struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params for system.open")
	}
	if p.URL == "" {
		return nil, fmt.Errorf("system.open requires {\"url\": \"...\"}")
	}
	lower := strings.ToLower(p.URL)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return nil, fmt.Errorf("system.open only accepts http/https urls")
	}
	if err := openDefault(p.URL); err != nil {
		return nil, fmt.Errorf("open url: %w", err)
	}
	return map[string]interface{}{"opened": true}, nil
}

func (b *Bridge) systemLog(_ context.Context, params json.RawMessage) (interface{}, error) {
	var p struct {
		Level   string `json:"level"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(params, &p)
	switch strings.ToLower(p.Level) {
	case "warn":
		log.Printf("[frontend-warn] %s", p.Message)
	case "error":
		log.Printf("[frontend-error] %s", p.Message)
	default:
		log.Printf("[frontend] %s", p.Message)
	}
	return map[string]interface{}{"logged": true}, nil
}

func (b *Bridge) appExit(_ context.Context, _ json.RawMessage) (interface{}, error) {
	// Give the reply a chance to reach the page before we tear down.
	time.AfterFunc(150*time.Millisecond, triggerExit)
	return map[string]interface{}{"exiting": true}, nil
}

func (b *Bridge) bridgeVersion(_ context.Context, _ json.RawMessage) (interface{}, error) {
	return map[string]interface{}{
		"rpc": "1.0.0", "runtime": runtime.Version(), "cli": "omni-desktop-factory",
	}, nil
}

func (b *Bridge) bridgeEcho(_ context.Context, params json.RawMessage) (interface{}, error) {
	var out interface{}
	_ = json.Unmarshal(params, &out)
	if out == nil {
		out = struct{}{}
	}
	return out, nil
}
