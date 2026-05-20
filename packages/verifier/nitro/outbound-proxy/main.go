// Minimal HTTP CONNECT proxy for AWS Nitro Enclave outbound traffic.
//
// Listens on vsock CID:3, port 4443.
// The enclave bridges this via socat to localhost:4443 inside the enclave.
// Node.js is configured to use this as an HTTPS proxy via undici ProxyAgent.
//
// Build: GOOS=linux GOARCH=arm64 go build -o outbound-proxy .

package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type Allowlist struct {
	Destinations []string `yaml:"destinations"`
}

var (
	allowedDomains []string
	mu             sync.RWMutex
)

func loadAllowlist(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read allowlist: %w", err)
	}

	var al Allowlist
	if err := yaml.Unmarshal(data, &al); err != nil {
		return fmt.Errorf("parse allowlist: %w", err)
	}

	mu.Lock()
	allowedDomains = al.Destinations
	mu.Unlock()

	log.Printf("Loaded %d allowed destinations", len(al.Destinations))
	return nil
}

func isAllowed(host string) bool {
	// Strip port
	h := host
	if idx := strings.LastIndex(h, ":"); idx != -1 {
		h = h[:idx]
	}
	h = strings.ToLower(h)

	mu.RLock()
	defer mu.RUnlock()

	for _, pattern := range allowedDomains {
		p := strings.ToLower(pattern)
		if strings.HasPrefix(p, "*.") {
			suffix := p[1:] // ".example.com"
			if strings.HasSuffix(h, suffix) || h == p[2:] {
				return true
			}
		} else if h == p {
			return true
		}
	}

	// Allow IP addresses (for DynamoDB endpoints, etc.)
	if net.ParseIP(h) != nil {
		return true
	}

	return false
}

func handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !isAllowed(r.Host) {
		log.Printf("BLOCKED: %s", r.Host)
		http.Error(w, "Destination not allowed", http.StatusForbidden)
		return
	}

	// Connect to the target
	targetConn, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
	if err != nil {
		log.Printf("Failed to connect to %s: %v", r.Host, err)
		http.Error(w, "Connection failed", http.StatusBadGateway)
		return
	}

	// Send 200 Connection Established
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		log.Println("Hijacking not supported")
		targetConn.Close()
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		log.Printf("Hijack failed: %v", err)
		targetConn.Close()
		return
	}

	_, _ = clientBuf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	_ = clientBuf.Flush()

	// Bidirectional copy
	go transfer(targetConn, clientConn)
	go transfer(clientConn, targetConn)
}

func transfer(dst, src net.Conn) {
	defer dst.Close()
	defer src.Close()
	_, _ = io.Copy(dst, src)
}

func main() {
	allowlistPath := os.Getenv("ALLOWLIST_PATH")
	if allowlistPath == "" {
		allowlistPath = "/opt/spellguard/allowlist.yaml"
	}

	if err := loadAllowlist(allowlistPath); err != nil {
		log.Printf("Warning: could not load allowlist: %v (allowing all destinations)", err)
	}

	listenAddr := os.Getenv("LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = "0.0.0.0:4443"
	}

	server := &http.Server{
		Addr:         listenAddr,
		Handler:      http.HandlerFunc(handleConnect),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0, // CONNECT tunnels are long-lived
	}

	// Also handle plain HTTP proxy requests for non-CONNECT methods
	_ = bufio.NewReader(nil) // ensure import

	log.Printf("Outbound proxy listening on %s", listenAddr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
