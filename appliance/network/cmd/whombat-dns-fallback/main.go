package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/CybexBV/whombat/appliance/network/internal/dnsfallback"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := dnsfallback.Apply(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "DNS fallback:", err)
		os.Exit(1)
	}
}
