package watch

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/presence/internal/camera"
)

// The test binary is its own fake presence-watch: started with `--model <dir>/<mode>` it plays the program in that
// mode; with `--probe` it lists two cameras.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && (os.Args[1] == "--model" || os.Args[1] == "--probe") {
		os.Exit(fake(os.Args[1:]))
	}
	// The race detector's children would wait a second at exit (atexit_sleep_ms).
	os.Setenv("GORACE", "atexit_sleep_ms=0")
	os.Exit(m.Run())
}

func fake(args []string) int {
	if args[0] == "--probe" {
		fmt.Println(`{"path":"/dev/video0","name":"Integrated Camera","kind":"colour","usable":true,"format":"YUYV","width":320,"height":240}`)
		fmt.Println(`{"path":"/dev/video2","name":"Integrated IR","kind":"infrared","usable":true,"format":"GREY","width":340,"height":340}`)
		return 0
	}
	flags := map[string]string{}
	for i := 0; i+1 < len(args); i += 2 {
		flags[args[i]] = args[i+1]
	}
	mode := filepath.Base(flags["--model"])
	if strings.Contains(strings.Join(args, " "), "--self-test") {
		if mode == "broken" {
			fmt.Fprintln(os.Stderr, "presence-watch: can't load the model: protobuf parsing failed")
			return 1
		}
		fmt.Println(`{"selfTest":"ok","input":[640,640],"ms":3}`)
		return 0
	}
	switch mode {
	case "busy":
		fmt.Fprintln(os.Stderr, "presence-watch: can't open /dev/video0: Device or resource busy")
		return 1
	case "stubborn":
		signal.Ignore(syscall.SIGTERM)
	default:
		signal.Notify(make(chan os.Signal, 1), syscall.SIGTERM) // SIGTERM ends it below
	}
	// The args name the camera; the threshold is passed on when set.
	fmt.Printf(`{"t":"2026-10-20T12:00:00.000Z","camera":%q,"format":"YUYV","width":320,"height":240}`+"\n", flags["--device"]+flags["--frames"])
	fmt.Println(`garbage`)
	fmt.Printf(`{"t":"2026-10-20T12:00:00.500Z","face":true,"score":%s,"luma":87}`+"\n", flags["--threshold"])
	fmt.Println(`{"t":"2026-10-20T12:00:01.000Z","face":false,"score":0.1,"luma":12}`)
	// Until stdin closes (a stubborn one doesn't care).
	in := bufio.NewReader(os.Stdin)
	for {
		if _, err := in.ReadByte(); err != nil {
			if mode == "stubborn" {
				time.Sleep(time.Hour) // a program that hangs; Stop kills it
			}
			return 0
		}
	}
}

type recorder struct {
	events chan Event
	exits  chan error
}

func newRecorder() *recorder {
	return &recorder{events: make(chan Event, 16), exits: make(chan error, 1)}
}

func (r *recorder) event(e Event)  { r.events <- e }
func (r *recorder) exit(err error) { r.exits <- err }

func (r *recorder) next(t *testing.T) Event {
	t.Helper()
	select {
	case e := <-r.events:
		return e
	case <-time.After(10 * time.Second):
		t.Fatal("no event")
		return Event{}
	}
}

func (r *recorder) exited(t *testing.T) error {
	t.Helper()
	select {
	case err := <-r.exits:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("the program didn't exit")
		return nil
	}
}

func program(t *testing.T, mode string) Program {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Program{Bin: self, Model: filepath.Join(t.TempDir(), mode), KillAfter: 5 * time.Second}
}

func TestSpawnReportsTheLinesAndStopEndsIt(t *testing.T) {
	p := program(t, "faces")
	p.Threshold = 0.75
	r := newRecorder()
	c, err := p.Spawn(camera.Camera{Path: "/dev/video0"}, r.event, r.exit)
	if err != nil {
		t.Fatal(err)
	}
	if e := r.next(t); e.Frame || e.Opened != "YUYV 320×240" {
		t.Fatalf("first event %+v", e)
	}
	if e := r.next(t); !e.Frame || !e.Face || e.Luma != 87 {
		t.Fatalf("second event %+v (is --threshold passed on?)", e)
	}
	if e := r.next(t); !e.Frame || e.Face || e.Luma != 12 {
		t.Fatalf("third event %+v", e)
	}
	c.Stop()
	c.Stop()
	if err := r.exited(t); err != nil {
		t.Fatalf("a stopped program: %v", err)
	}
	<-c.Done()
}

func TestStopKillsAProgramThatWontExit(t *testing.T) {
	r := newRecorder()
	p := program(t, "stubborn")
	p.KillAfter = 100 * time.Millisecond
	c, err := p.Spawn(camera.Camera{Path: "/dev/video0"}, r.event, r.exit)
	if err != nil {
		t.Fatal(err)
	}
	r.next(t)
	c.Stop()
	err = r.exited(t)
	var ee interface{ ExitCode() int }
	if !errors.As(err, &ee) || ee.ExitCode() != -1 || !strings.Contains(err.Error(), "killed") {
		t.Fatalf("not killed: %v", err)
	}
}

func TestAFailingProgramSaysWhy(t *testing.T) {
	r := newRecorder()
	if _, err := program(t, "busy").Spawn(camera.Camera{Path: "/dev/video0"}, r.event, r.exit); err != nil {
		t.Fatal(err)
	}
	if err := r.exited(t); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("exit: %v", err)
	}
}

func TestFramesCamera(t *testing.T) {
	r := newRecorder()
	c, err := program(t, "faces").Spawn(camera.Camera{Path: "/pictures", Frames: true}, r.event, r.exit)
	if err != nil {
		t.Fatal(err)
	}
	r.next(t)
	c.Stop()
	r.exited(t)
}

func TestSpawnWithoutTheProgram(t *testing.T) {
	_, err := Program{Bin: filepath.Join(t.TempDir(), "missing")}.Spawn(camera.Camera{Path: "/dev/video0"}, nil, nil)
	if err == nil {
		t.Fatal("started a missing program")
	}
}

func TestSelfTestAndProbe(t *testing.T) {
	if err := program(t, "ok").SelfTest(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := program(t, "broken").SelfTest(context.Background()); err == nil || !strings.Contains(err.Error(), "protobuf") {
		t.Fatalf("broken model: %v", err)
	}
	out, err := program(t, "ok").Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cs := camera.Parse(out)
	if len(cs) != 2 || cs[0].Path != "/dev/video0" || !cs[1].Infrared() {
		t.Fatalf("probe: %+v", cs)
	}
}
