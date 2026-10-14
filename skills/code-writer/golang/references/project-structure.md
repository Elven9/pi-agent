# Project Structure and Module Management

## Standard Project Layout

```
myproject/
├── cmd/                    # Main applications
│   ├── server/
│   │   └── main.go        # Entry point for server
│   └── cli/
│       └── main.go        # Entry point for CLI tool
├── internal/              # Private application code
│   ├── api/              # API handlers
│   ├── service/          # Business logic
│   └── repository/       # Data access layer
├── pkg/                   # Public library code
│   └── models/           # Shared models
├── scripts/               # Build and install scripts
├── configs/              # Configuration files
├── deployments/          # Docker, K8s configs
├── test/                 # Additional test data
├── docs/                 # Documentation
├── go.mod               # Module definition
├── go.sum               # Dependency checksums
├── Makefile             # Build automation
└── README.md
```

## Module Commands

```bash
# Initialize module
go mod init github.com/user/project

# Add missing dependencies
go mod tidy

# Verify dependencies
go mod verify

# Show module graph
go mod graph

# Show why package is needed
go mod why github.com/user/package

# Update dependency
go get -u github.com/user/package

# Update to specific version
go get github.com/user/package@v1.2.3

# Update all dependencies
go get -u ./...

# Remove unused dependencies
go mod tidy
```

## Internal Packages

```go
// internal/ packages can only be imported by code in the parent tree

myproject/
├── internal/
│   ├── auth/           # Can only be imported by myproject
│   │   └── jwt.go
│   └── database/
│       └── postgres.go
└── pkg/
    └── models/         # Can be imported by anyone
        └── user.go

// This works (same project):
import "github.com/user/myproject/internal/auth"

// This fails (different project):
import "github.com/other/project/internal/auth" // Error!

// Internal subdirectories
myproject/
└── api/
    └── internal/       # Can only be imported by code in api/
        └── helpers.go
```

## Build Tags and Constraints

```go
// +build integration
// integration_test.go

package myapp

import "testing"

func TestIntegration(t *testing.T) {
    // Integration test code
}

// Build: go test -tags=integration
```

## Makefile Example

```makefile
# Makefile
.PHONY: build test lint clean run

# Variables
BINARY_NAME=myapp
BUILD_DIR=bin
GO=go
GOFLAGS=-v

# Build the application
build:
	$(GO) build $(GOFLAGS) -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/server

# Run tests
test:
	$(GO) test -v -race -coverprofile=coverage.out ./...

# Run tests with coverage report
test-coverage: test
	$(GO) tool cover -html=coverage.out

# Run linters
lint:
	golangci-lint run ./...

# Format code
fmt:
	$(GO) fmt ./...
	goimports -w .

# Run the application
run:
	$(GO) run ./cmd/server

# Clean build artifacts
clean:
	rm -rf $(BUILD_DIR)
	rm -f coverage.out

# Install dependencies
deps:
	$(GO) mod download
	$(GO) mod tidy

# Build for multiple platforms
build-all:
	GOOS=linux GOARCH=amd64 $(GO) build -o $(BUILD_DIR)/$(BINARY_NAME)-linux-amd64 ./cmd/server
	GOOS=darwin GOARCH=amd64 $(GO) build -o $(BUILD_DIR)/$(BINARY_NAME)-darwin-amd64 ./cmd/server
	GOOS=windows GOARCH=amd64 $(GO) build -o $(BUILD_DIR)/$(BINARY_NAME)-windows-amd64.exe ./cmd/server

# Run with race detector
run-race:
	$(GO) run -race ./cmd/server

# Generate code
generate:
	$(GO) generate ./...

# Docker build
docker-build:
	docker build -t $(BINARY_NAME):latest .

# Help
help:
	@echo "Available targets:"
	@echo "  build         - Build the application"
	@echo "  test          - Run tests"
	@echo "  test-coverage - Run tests with coverage report"
	@echo "  lint          - Run linters"
	@echo "  fmt           - Format code"
	@echo "  run           - Run the application"
	@echo "  clean         - Clean build artifacts"
	@echo "  deps          - Install dependencies"
```

## Dockerfile Multi-Stage Build

```dockerfile
# Build stage
# Match the go directive in go.mod (1.26+ recommended)
FROM golang:1.26-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o server ./cmd/server

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/server .

# Copy config files if needed
COPY --from=builder /app/configs ./configs

EXPOSE 8080

CMD ["./server"]
```

## Version Information

```go
// version/version.go
package version

import "runtime"

var (
    // Set via ldflags during build
    Version   = "dev"
    GitCommit = "none"
    BuildTime = "unknown"
)

// Info returns version information
func Info() map[string]string {
    return map[string]string{
        "version":    Version,
        "git_commit": GitCommit,
        "build_time": BuildTime,
        "go_version": runtime.Version(),
        "os":         runtime.GOOS,
        "arch":       runtime.GOARCH,
    }
}

// Build with version info:
// go build -ldflags "-X github.com/user/project/version.Version=1.0.0 \
//   -X github.com/user/project/version.GitCommit=$(git rev-parse HEAD) \
//   -X github.com/user/project/version.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## Configuration Management

Always use [Viper](https://github.com/spf13/viper) (`go get github.com/spf13/viper`, v1.21+,
needs Go 1.23+). Don't hand-roll config parsing with `os.Getenv`, `flag` or `encoding/json`.

**Rules**

- Put config in `internal/config/`: one `Config` struct and one `Load` function that returns it.
- Create an instance with `viper.New()` and never use the global `viper.*` functions (they
  make testing harder and may be deprecated).
- Read the config once at startup with `Load`, then pass the typed `Config` (or one of its
  sub-structs) to the code that needs it. Don't pass `*viper.Viper` around or call
  `v.GetString(...)` deep in business logic.
- Tag every field with `mapstructure:"..."`, since `yaml` and `json` tags are ignored when
  unmarshaling.
- Call `SetDefault` for **every** key, including ones with an empty default. `Unmarshal` only
  sees keys Viper already knows, so an env var for a key with no default and no file entry is
  silently dropped.
- Env vars: call `SetEnvPrefix("APP")`, then `SetEnvKeyReplacer(strings.NewReplacer(".", "_"))`,
  then `AutomaticEnv()`, so `server.port` maps to `APP_SERVER_PORT`.
- Precedence, highest first: `Set`, then flags, then env, then the config file, then
  defaults. Nested values aren't deep-merged: a map from a higher source replaces the whole
  map from a lower one.
- A missing config file is fine (defaults + env still work). Any other read error is fatal.
  Check for it with `errors.As(err, &viper.ConfigFileNotFoundError{})`.
- Validate after unmarshaling (required values, ranges) and return an error. Don't panic.
- Keys are case-insensitive. A `*viper.Viper` is not safe for concurrent read/write.
- Keep sample config in `configs/config.example.yaml`. Never commit secrets: take them from
  env vars.

**Example**

```go
// internal/config/config.go
package config

import (
    "errors"
    "fmt"
    "strings"
    "time"

    "github.com/spf13/viper"
)

type Config struct {
    Server   ServerConfig   `mapstructure:"server"`
    Database DatabaseConfig `mapstructure:"database"`
    LogLevel string         `mapstructure:"log_level"`
}

type ServerConfig struct {
    Port        int           `mapstructure:"port"`
    ReadTimeout time.Duration `mapstructure:"read_timeout"` // "5s" parses to time.Duration
}

type DatabaseConfig struct {
    DSN string `mapstructure:"dsn"` // secret: set APP_DATABASE_DSN
}

// Load reads defaults, then an optional config file, then APP_* env vars.
// path may be empty to search the default locations.
func Load(path string) (*Config, error) {
    v := viper.New()

    v.SetDefault("server.port", 8080)
    v.SetDefault("server.read_timeout", "5s")
    v.SetDefault("database.dsn", "") // registers the key so the env var is picked up
    v.SetDefault("log_level", "info")

    if path != "" {
        v.SetConfigFile(path)
    } else {
        v.SetConfigName("config") // config.yaml, config.json, ...
        v.AddConfigPath("./configs")
        v.AddConfigPath(".")
    }
    if err := v.ReadInConfig(); err != nil {
        var notFound viper.ConfigFileNotFoundError
        if !errors.As(err, &notFound) {
            return nil, fmt.Errorf("read config: %w", err)
        }
    }

    v.SetEnvPrefix("APP")
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
    v.AutomaticEnv()

    var cfg Config
    if err := v.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("decode config: %w", err)
    }
    if cfg.Database.DSN == "" {
        return nil, errors.New("database.dsn is required (APP_DATABASE_DSN)")
    }
    return &cfg, nil
}
```

**Flags (Cobra/pflag).** Bind a flag to its key before `Unmarshal` so the flag overrides env
and the file: `v.BindPFlag("server.port", cmd.Flags().Lookup("port"))`. The standard `flag`
package isn't supported directly: add its flags to pflag with
`pflag.CommandLine.AddGoFlagSet(flag.CommandLine)`.

**Avoid unless asked:** `WatchConfig` hot reload (needs locking around reads), remote
key/value stores (`viper/remote`), and `WriteConfig`.

## Quick Reference

| Command                      | Description             |
| ---------------------------- | ----------------------- |
| `go mod init`                | Initialize module       |
| `go mod tidy`                | Add/remove dependencies |
| `go mod download`            | Download dependencies   |
| `go get package@version`     | Add/update dependency   |
| `go build -ldflags "-X ..."` | Set version info        |
| `go generate ./...`          | Run code generation     |
| `GOOS=linux go build`        | Cross-compile           |
| `go work init`               | Initialize workspace    |
