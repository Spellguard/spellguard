// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// StateStore keeps the checkpoint hashes a verifier has seen, keyed by
// StateKey, so a later run notices a stream that was rewritten.
type StateStore interface {
	Load(key string) (*SavedStream, error)
	Save(key string, s *SavedStream) error
	All() (map[string]*SavedStream, error)
}

// StateKey is the key a stream's saved checkpoints are stored under.
func StateKey(bucket, generation, stream string) string {
	return bucket + "/" + generation + "/" + stream
}

type stateFile struct {
	Format  int                     `json:"format"`
	Streams map[string]*SavedStream `json:"streams"`
}

func cloneStream(s *SavedStream) *SavedStream {
	c := *s
	c.Checkpoints = make(map[string]string, len(s.Checkpoints))
	for k, v := range s.Checkpoints {
		c.Checkpoints[k] = v
	}
	return &c
}

// DefaultStatePath is where the command keeps saved checkpoints:
// <user config dir>/spellguard/audit-verify/state.json.
func DefaultStatePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "spellguard", "audit-verify", "state.json"), nil
}

// FileState stores saved checkpoints in a JSON file, in the same shape the
// TypeScript implementation keeps in browser storage.
func FileState(path string) StateStore {
	return &fileState{path: path}
}

type fileState struct {
	path string
	mu   sync.Mutex
}

func (f *fileState) read() (*stateFile, error) {
	raw, err := os.ReadFile(f.path)
	if errors.Is(err, fs.ErrNotExist) {
		return &stateFile{Format: 1, Streams: map[string]*SavedStream{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading saved checkpoints %s: %w", f.path, err)
	}
	var file stateFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("saved checkpoints %s are unreadable: %w", f.path, err)
	}
	if file.Streams == nil {
		file.Streams = map[string]*SavedStream{}
	}
	file.Format = 1
	return &file, nil
}

func (f *fileState) Load(key string) (*SavedStream, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	file, err := f.read()
	if err != nil {
		return nil, err
	}
	if s := file.Streams[key]; s != nil {
		return cloneStream(s), nil
	}
	return nil, nil
}

func (f *fileState) All() (map[string]*SavedStream, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	file, err := f.read()
	if err != nil {
		return nil, err
	}
	return file.Streams, nil
}

func (f *fileState) Save(key string, s *SavedStream) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	file, err := f.read()
	if err != nil {
		return err
	}
	file.Streams[key] = cloneStream(s)
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.path), ".state-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), f.path)
}

// MemoryState keeps saved checkpoints in memory; initial is a state file's
// streams.
func MemoryState(initial map[string]*SavedStream) StateStore {
	m := &memoryState{streams: map[string]*SavedStream{}}
	for k, s := range initial {
		m.streams[k] = cloneStream(s)
	}
	return m
}

type memoryState struct {
	mu      sync.Mutex
	streams map[string]*SavedStream
}

func (m *memoryState) Load(key string) (*SavedStream, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.streams[key]; s != nil {
		return cloneStream(s), nil
	}
	return nil, nil
}

func (m *memoryState) Save(key string, s *SavedStream) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.streams[key] = cloneStream(s)
	return nil
}

func (m *memoryState) All() (map[string]*SavedStream, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]*SavedStream, len(m.streams))
	for k, s := range m.streams {
		out[k] = cloneStream(s)
	}
	return out, nil
}
