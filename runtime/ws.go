package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// This file implements the MINIMAL slice of RFC 6455 that the omni bridge
// needs: text frames (client->server masked, server->client unmasked),
// ping/pong keepalive and clean close. No external dependency, no CGO,
// nothing the Go toolchain cannot build offline.

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	conn    net.Conn
	br      *bufio.Reader
	writeMu sync.Mutex
}

// wsUpgrade completes the HTTP 101 handshake and hijacks the connection.
func wsUpgrade(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("invalid Upgrade header")
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return nil, errors.New("invalid Connection header")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	if r.ProtoMajor < 1 || (r.ProtoMajor == 1 && r.ProtoMinor < 1) {
		return nil, errors.New("HTTP/1.1 required")
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])

	w.Header().Set("Upgrade", "websocket")
	w.Header().Set("Connection", "Upgrade")
	w.Header().Set("Sec-WebSocket-Accept", accept)
	w.WriteHeader(http.StatusSwitchingProtocols)

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("hijack not supported by the server")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	return &wsConn{conn: conn, br: brw.Reader}, nil
}

// readMessage reads one assembled (defragmented) application message.
// It returns opcode 0x8 when the peer sends a close frame.
func (c *wsConn) readMessage() (int, []byte, error) {
	var msg []byte
	for {
		opcode, payload, last, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case 0x8: // close
			return 0x8, payload, nil
		case 0x1, 0x2, 0x0: // text, binary, continuation
			if opcode != 0x0 {
				msg = msg[:0]
			}
			msg = append(msg, payload...)
			if last {
				op := opcode
				if op == 0x0 {
					op = 0x1 // continuation finishes a text message
				}
				return int(op), msg, nil
			}
		}
		// ping (0x9) / pong (0xA) are handled inside readFrame
	}
}

// readFrame parses a single websocket frame, answers pings and unmasks
// client payloads.
func (c *wsConn) readFrame() (opcode byte, payload []byte, last bool, err error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(2 * time.Hour))

	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return 0, nil, false, err
	}
	fin := hdr[0]&0x80 != 0
	opcode = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0

	var n uint64
	switch l := hdr[1] & 0x7F; l {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(c.br, b[:]); err != nil {
			return 0, nil, false, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(c.br, b[:]); err != nil {
			return 0, nil, false, err
		}
		n = binary.BigEndian.Uint64(b[:])
	default:
		n = uint64(l)
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, mask[:]); err != nil {
			return 0, nil, false, err
		}
	}
	buf := make([]byte, n)
	if n > 0 {
		if _, err := io.ReadFull(c.br, buf); err != nil {
			return 0, nil, false, err
		}
	}
	if masked {
		for i := range buf {
			buf[i] ^= mask[i%4]
		}
	}

	switch opcode {
	case 0x8, 0x9, 0xA:
		if opcode == 0x9 {
			_ = c.writeFrame(0xA, buf) // answer ping with pong
		}
		return opcode, buf, true, nil
	}
	return opcode, buf, fin, nil
}

// writeFrame sends a frame; server->client frames are never masked.
func (c *wsConn) writeFrame(opcode byte, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))

	var hdr [10]byte
	hdr[0] = 0x80 | opcode
	var off int
	switch n := len(data); {
	case n < 126:
		hdr[1] = byte(n)
		off = 2
	case n <= 0xFFFF:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		off = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		off = 10
	}
	if _, err := c.conn.Write(hdr[:off]); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := c.conn.Write(data); err != nil {
			return err
		}
	}
	return nil
}

func (c *wsConn) writeText(b []byte) error { return c.writeFrame(0x1, b) }
func (c *wsConn) close() error             { return c.conn.Close() }
