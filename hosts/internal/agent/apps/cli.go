package apps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Env is the environment of the docker commands: root's home, so the
// registry sign-ins `docker login` saved there are used for private images.
var Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "LANG=C"}

// CLI is Docker through the docker command on the server.
type CLI struct {
	docker string
	once   sync.Once
	// compose: the command that runs Compose ("docker compose" or
	// docker-compose); nil when neither is there.
	compose []string
}

// NewCLI finds the docker command.
func NewCLI() *CLI {
	c := &CLI{docker: "docker"}
	for _, p := range []string{"/usr/bin/docker", "/usr/local/bin/docker", "/bin/docker", "/snap/bin/docker"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			c.docker = p
			break
		}
	}
	return c
}

func (c *CLI) run(ctx context.Context, timeout time.Duration, w io.Writer, argv ...string) error {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, argv[0], argv[1:]...)
	cmd.Env = Env
	cmd.Dir = "/"
	var t tail
	if w != nil {
		cmd.Stdout, cmd.Stderr = io.MultiWriter(w, &t), io.MultiWriter(w, &t)
	} else {
		cmd.Stdout, cmd.Stderr = &t, &t
	}
	err := cmd.Run()
	if err != nil {
		if cctx.Err() != nil {
			return fmt.Errorf("%s took too long and was stopped", argv[len(argv)-1])
		}
		if line := lastLine(t.b.String()); line != "" {
			return errors.New(line)
		}
		return err
	}
	return nil
}

func (c *CLI) output(ctx context.Context, argv ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, argv[0], argv[1:]...)
	cmd.Env = Env
	cmd.Dir = "/"
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return out, errors.New(lastLine(string(ee.Stderr)))
		}
	}
	return out, err
}

// inspected is docker inspect's JSON (the parts read).
type inspected struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Image  string `json:"Image"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	RestartCount int `json:"RestartCount"`
}

func (i inspected) container() Container {
	c := Container{ID: i.ID, Name: strings.TrimPrefix(i.Name, "/"), ImageID: i.Image, Ref: i.Config.Image,
		Labels: i.Config.Labels, Status: i.State.Status, RestartCount: i.RestartCount}
	if h := i.State.Health; h != nil && h.Status != "none" {
		c.Health = h.Status
	}
	return c
}

func (c *CLI) inspect(ctx context.Context, ids ...string) ([]Container, error) {
	out, err := c.output(ctx, append([]string{c.docker, "inspect", "--type", "container", "--"}, ids...)...)
	if err != nil {
		return nil, err
	}
	var list []inspected
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	cs := make([]Container, 0, len(list))
	for _, i := range list {
		cs = append(cs, i.container())
	}
	return cs, nil
}

func (c *CLI) Container(ctx context.Context, name string) (*Container, error) {
	cs, err := c.inspect(ctx, name)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such") {
			return nil, nil
		}
		return nil, err
	}
	if len(cs) == 0 {
		return nil, nil
	}
	return &cs[0], nil
}

func (c *CLI) ProjectContainers(ctx context.Context, project string) ([]Container, error) {
	out, err := c.output(ctx, c.docker, "ps", "--all", "--quiet", "--no-trunc",
		"--filter", "label="+LabelProject+"="+project)
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, nil
	}
	cs, err := c.inspect(ctx, ids...)
	if err != nil {
		return nil, err
	}
	// A one-off `compose run` container of the service isn't the app.
	out2 := cs[:0]
	for _, x := range cs {
		if !strings.EqualFold(x.Labels[LabelOneOff], "true") {
			out2 = append(out2, x)
		}
	}
	return out2, nil
}

func (c *CLI) Image(ctx context.Context, ref string) (string, map[string]string, error) {
	out, err := c.output(ctx, c.docker, "image", "inspect", "--", ref)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such") {
			return "", nil, nil
		}
		return "", nil, err
	}
	var list []struct {
		ID     string `json:"Id"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := json.Unmarshal(out, &list); err != nil || len(list) == 0 {
		return "", nil, err
	}
	return list[0].ID, list[0].Config.Labels, nil
}

func (c *CLI) Pull(ctx context.Context, ref string, w io.Writer) error {
	// A big image on a slow line.
	return c.run(ctx, 20*time.Minute, w, c.docker, "pull", "--", ref)
}

func (c *CLI) Tag(ctx context.Context, src, dst string) error {
	return c.run(ctx, time.Minute, nil, c.docker, "tag", "--", src, dst)
}

func (c *CLI) Untag(ctx context.Context, ref string) error {
	return c.run(ctx, time.Minute, nil, c.docker, "image", "rm", "--", ref)
}

// ConfigHash reads `docker compose config --hash=<service>`: one line,
// "<service> <hash>".
func (c *CLI) ConfigHash(ctx context.Context, p Project, service string) (string, error) {
	cmd := c.composeCmd(ctx)
	if cmd == nil {
		return "", ErrNoCompose
	}
	argv := append(append(append([]string{}, cmd...), p.Args()...), "config", "--hash="+service)
	out, err := c.output(ctx, argv...)
	if err != nil {
		return "", err
	}
	return parseConfigHash(string(out), service)
}

// parseConfigHash finds the service's hash in `config --hash` output.
func parseConfigHash(out, service string) (string, error) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == service && ValidConfigHash(f[1]) {
			return f[1], nil
		}
	}
	return "", fmt.Errorf("compose didn’t say the settings of %s", service)
}

// composeCmd finds Compose: the docker plugin, else docker-compose.
func (c *CLI) composeCmd(ctx context.Context) []string {
	c.once.Do(func() {
		if _, err := c.output(ctx, c.docker, "compose", "version"); err == nil {
			c.compose = []string{c.docker, "compose"}
			return
		}
		for _, p := range []string{"/usr/bin/docker-compose", "/usr/local/bin/docker-compose"} {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				c.compose = []string{p}
				return
			}
		}
	})
	return c.compose
}

func (c *CLI) Compose(ctx context.Context, p Project, w io.Writer, args ...string) error {
	cmd := c.composeCmd(ctx)
	if cmd == nil {
		return ErrNoCompose
	}
	timeout := 5 * time.Minute
	argv := append(append(append([]string{}, cmd...), p.Args()...), args...)
	return c.run(ctx, timeout, w, argv...)
}
