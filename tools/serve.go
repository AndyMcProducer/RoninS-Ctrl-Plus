// Dependency-free static server for RoninS-Ctrl-Plus.
//
// This is the same server as tools/serve.mjs, written in Go so the portable Mac
// download can ship a self-contained binary and run with no Node.js or Python.
// It is also handy on any machine with a Go toolchain:
//
//	go run tools/serve.go [port]
//
// Web Bluetooth requires a secure context. http://localhost counts as one, so
// plain HTTP on localhost is all the app needs.
//
// Routes:
//
//	/            app from web/
//	/docs/       documentation from docs/
//	/bridge/     CAN bridge notes from bridge/
//	/README.md   repository README
//	/LICENSE     project licence
package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const defaultPort = 8080

func main() {
	log.SetFlags(0)

	port := defaultPort
	if len(os.Args) > 1 && strings.TrimSpace(os.Args[1]) != "" {
		parsed, err := strconv.Atoi(strings.TrimSpace(os.Args[1]))
		if err != nil || parsed < 1 || parsed > 65535 {
			log.Fatalf("Invalid port %q. Use a number between 1 and 65535.", os.Args[1])
		}
		port = parsed
	} else if env := os.Getenv("PORT"); env != "" {
		parsed, err := strconv.Atoi(env)
		if err == nil && parsed > 0 && parsed <= 65535 {
			port = parsed
		}
	}

	root, err := findRoot()
	if err != nil {
		log.Fatalf("Could not find the application files: %v", err)
	}

	handler := &appHandler{root: root}
	server := &http.Server{
		Addr:              net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		if isInUse(err) {
			log.Fatalf("Port %d is already in use. Try: %s %d", port, filepath.Base(os.Args[0]), port+1)
		}
		log.Fatalf("Could not start the server: %v", err)
	}

	fmt.Println()
	fmt.Println("  RoninS-Ctrl-Plus")
	fmt.Printf("  http://localhost:%d\n", port)
	fmt.Println()
	fmt.Println("  Open it in Chrome or Edge. Web Bluetooth needs a secure context,")
	fmt.Println("  and http://localhost is one. Press Ctrl+C to stop.")
	fmt.Println()

	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("Server error: %v", err)
	}
}

// findRoot locates the folder that contains web/index.html. The binary ships in
// runtime/, so walk up from the executable first, then fall back to the working
// directory for "go run tools/serve.go".
func findRoot() (string, error) {
	var candidates []string

	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		candidates = append(candidates, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd)
	}

	for _, start := range candidates {
		dir := start
		for depth := 0; depth < 5; depth++ {
			index := filepath.Join(dir, "web", "index.html")
			if info, err := os.Stat(index); err == nil && info.Mode().IsRegular() {
				return dir, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}

	return "", errors.New("web/index.html was not found next to the server")
}

func isInUse(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return strings.Contains(strings.ToLower(opErr.Err.Error()), "in use")
	}
	return false
}

type appHandler struct {
	root string
}

func (h *appHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	requestPath := "/"

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	cleanPath := r.URL.Path
	if cleanPath == "" || cleanPath == "/" {
		cleanPath = "/index.html"
	}
	requestPath = cleanPath

	file, size, found := h.resolve(cleanPath)
	if !found {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, "Not found: %s\n", cleanPath)
		logLine(http.StatusNotFound, requestPath, started)
		return
	}

	handle, err := os.Open(file)
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Could not read %s\n", cleanPath)
		logLine(http.StatusInternalServerError, requestPath, started)
		return
	}
	defer handle.Close()

	w.Header().Set("Content-Type", contentType(file))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	if r.Method != http.MethodHead {
		if _, err := io.Copy(w, handle); err != nil {
			// The client went away; nothing useful to send now.
			logLine(http.StatusOK, requestPath, started)
			return
		}
	}
	logLine(http.StatusOK, requestPath, started)
}

// resolve maps a URL path onto a file, keeping the result inside its base
// folder so ".." cannot escape.
func (h *appHandler) resolve(urlPath string) (string, int64, bool) {
	base := h.baseFor(urlPath)

	decoded, err := decodePath(urlPath)
	if err != nil {
		return "", 0, false
	}

	relative := strings.TrimLeft(strings.ReplaceAll(decoded, "\\", "/"), "/")
	if relative == "" {
		relative = "index.html"
	}

	target := filepath.Join(base, filepath.FromSlash(path.Clean(relative)))

	prefix := base
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if target != base && !strings.HasPrefix(target, prefix) {
		return "", 0, false
	}

	info, err := os.Stat(target)
	if err != nil {
		return "", 0, false
	}

	if info.IsDir() {
		index := filepath.Join(target, "index.html")
		indexInfo, err := os.Stat(index)
		if err != nil || !indexInfo.Mode().IsRegular() {
			return "", 0, false
		}
		return index, indexInfo.Size(), true
	}

	if !info.Mode().IsRegular() {
		return "", 0, false
	}
	return target, info.Size(), true
}

func (h *appHandler) baseFor(urlPath string) string {
	shared := urlPath == "/docs" ||
		strings.HasPrefix(urlPath, "/docs/") ||
		urlPath == "/bridge" ||
		strings.HasPrefix(urlPath, "/bridge/") ||
		urlPath == "/README.md" ||
		urlPath == "/LICENSE"

	if shared {
		return h.root
	}
	return filepath.Join(h.root, "web")
}

func contentType(file string) string {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".md":
		return "text/markdown; charset=utf-8"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".ico":
		return "image/x-icon"
	case ".wasm":
		return "application/wasm"
	}

	if byType := mime.TypeByExtension(filepath.Ext(file)); byType != "" {
		return byType
	}
	return "application/octet-stream"
}

// decodePath percent-decodes a URL path, rejecting malformed escapes.
func decodePath(value string) (string, error) {
	if !strings.Contains(value, "%") {
		return value, nil
	}

	var builder strings.Builder
	builder.Grow(len(value))
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character != '%' {
			builder.WriteByte(character)
			continue
		}
		if index+2 >= len(value) {
			return "", errors.New("truncated escape")
		}
		high, okHigh := hexValue(value[index+1])
		low, okLow := hexValue(value[index+2])
		if !okHigh || !okLow {
			return "", errors.New("invalid escape")
		}
		builder.WriteByte(high<<4 | low)
		index += 2
	}
	return builder.String(), nil
}

func hexValue(character byte) (byte, bool) {
	switch {
	case character >= '0' && character <= '9':
		return character - '0', true
	case character >= 'a' && character <= 'f':
		return character - 'a' + 10, true
	case character >= 'A' && character <= 'F':
		return character - 'A' + 10, true
	}
	return 0, false
}

func logLine(status int, requestPath string, started time.Time) {
	fmt.Printf("%d  %s  %dms\n", status, requestPath, time.Since(started).Milliseconds())
}
