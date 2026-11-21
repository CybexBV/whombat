// Command fakeruntime serves the test double of the runtime admin socket (BK-05 barrier semantics) for
// scripted integration runs (backup/scripts/e2e.sh).
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/CybexBV/whombat/appliance/backup/internal/fakeruntime"
)

func main() {
	sock := flag.String("socket", "", "unix socket path")
	flag.Parse()
	rt, err := fakeruntime.Start(*sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer rt.Close()
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	<-c
	d, r := rt.Counts()
	fmt.Fprintf(os.Stderr, "fakeruntime: %d drain requests, %d resumes, barrier held %s in total\n", d, r, rt.HeldTotal)
}
