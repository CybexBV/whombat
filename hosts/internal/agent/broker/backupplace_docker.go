package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Docker Engine API calls of the backup places (backupplace.go), over the
// same socket as dockerDriver.

// placeContainer is what a backup place needs of a container
// (GET /containers/{name}/json).
type placeContainer struct {
	ID     string `json:"Id"`
	Name   string `json:"Name"`
	Image  string `json:"Image"` // the image id
	Config struct {
		Image  string            `json:"Image"` // as created
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Running  bool   `json:"Running"`
		Status   string `json:"Status"`
		ExitCode int    `json:"ExitCode"`
	} `json:"State"`
	HostConfig struct {
		Binds        []string `json:"Binds"`
		PortBindings map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"PortBindings"`
	} `json:"HostConfig"`
}

// placeListEntry is an entry of GET /containers/json.
type placeListEntry struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Labels map[string]string `json:"Labels"`
	Ports  []struct {
		PrivatePort int    `json:"PrivatePort"`
		PublicPort  int    `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
	Mounts []struct {
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
}

// containerSpec is the body of POST /containers/create.
type containerSpec struct {
	Image        string              `json:"Image"`
	Entrypoint   []string            `json:"Entrypoint,omitempty"`
	Cmd          []string            `json:"Cmd,omitempty"`
	Env          []string            `json:"Env,omitempty"`
	User         string              `json:"User,omitempty"`
	Labels       map[string]string   `json:"Labels"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig   containerHostConfig `json:"HostConfig"`
}

type containerHostConfig struct {
	Binds         []string                 `json:"Binds"`
	Tmpfs         map[string]string        `json:"Tmpfs,omitempty"`
	PortBindings  map[string][]portBinding `json:"PortBindings,omitempty"`
	RestartPolicy struct {
		Name string `json:"Name"`
	} `json:"RestartPolicy"`
	NetworkMode string `json:"NetworkMode,omitempty"`
}

type portBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

// dockerPing reports whether the daemon answers.
func (d *dockerDriver) dockerPing(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := d.call(ctx, http.MethodGet, "/_ping", nil, nil)
	return err
}

// inspectContainer returns a container, nil when there is none.
func (d *dockerDriver) inspectContainer(ctx context.Context, name string) (*placeContainer, error) {
	var c placeContainer
	status, err := d.call(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, &c)
	if status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// listContainers lists every container (stopped ones too), those with
// the label when it is not empty.
func (d *dockerDriver) listContainers(ctx context.Context, label string) ([]placeListEntry, error) {
	q := url.Values{"all": {"1"}}
	if label != "" {
		f, _ := json.Marshal(map[string][]string{"label": {label}})
		q.Set("filters", string(f))
	}
	var out []placeListEntry
	_, err := d.call(ctx, http.MethodGet, "/containers/json?"+q.Encode(), nil, &out)
	return out, err
}

// createContainer creates (not starts) a container.
func (d *dockerDriver) createContainer(ctx context.Context, name string, spec containerSpec) error {
	_, err := d.call(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), spec, nil)
	return err
}

// startContainer starts a container (already started: fine).
func (d *dockerDriver) startContainer(ctx context.Context, name string) error {
	_, err := d.call(ctx, http.MethodPost, "/containers/"+url.PathEscape(name)+"/start", nil, nil)
	return err
}

// stopContainer stops a container (stopped or missing: fine).
func (d *dockerDriver) stopContainer(ctx context.Context, name string) error {
	status, err := d.call(ctx, http.MethodPost, "/containers/"+url.PathEscape(name)+"/stop?t=30", nil, nil)
	if status == http.StatusNotFound || status == http.StatusNotModified {
		return nil
	}
	return err
}

// removeContainer stops and removes a container; one that isn't there is
// fine. Its volumes stay (it has only bind mounts).
func (d *dockerDriver) removeContainer(ctx context.Context, name string) error {
	p := "/containers/" + url.PathEscape(name)
	status, err := d.call(ctx, http.MethodPost, p+"/stop?t=10", nil, nil)
	if status == http.StatusNotFound {
		return nil
	}
	if err != nil && status != http.StatusNotModified {
		return err
	}
	status, err = d.call(ctx, http.MethodDelete, p, nil, nil)
	if status == http.StatusNotFound {
		return nil
	}
	return err
}

// hasImage reports whether the image is there (a reference with a
// digest: exactly that one).
func (d *dockerDriver) hasImage(ctx context.Context, ref string) (bool, error) {
	status, err := d.call(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil)
	if status == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}

// pullImage pulls "repo@sha256:…" and waits for the end of the pull; an
// error in the progress stream fails it.
func (d *dockerDriver) pullImage(ctx context.Context, ref string) error {
	repo, digest, ok := strings.Cut(ref, "@")
	if !ok {
		return codeErr(CodeInvalid, "the image has no digest")
	}
	q := url.Values{"fromImage": {repo}, "tag": {digest}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker/images/create?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	resp, err := d.httpClient().Do(req)
	if err != nil {
		var ce *codeError
		if errors.As(err, &ce) {
			return err
		}
		return codeErr(CodePlatformError, "cannot reach Docker: "+err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return codeErr(CodePlatformError, "Docker couldn’t download "+repo+": "+dockerError(resp.StatusCode, b))
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var m struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(bytes.TrimSpace(sc.Bytes()), &m) == nil && m.Error != "" {
			return codeErr(CodePlatformError, "Docker couldn’t download "+repo+": "+firstLine(m.Error, 300))
		}
	}
	if err := sc.Err(); err != nil {
		return codeErr(CodePlatformError, "Docker couldn’t download "+repo+": "+err.Error())
	}
	return nil
}

// publishedPort is the host port bound to a container port ("8000/tcp"),
// 0 when none.
func (c *placeContainer) publishedPort(cport string) int {
	for _, b := range c.HostConfig.PortBindings[cport] {
		if n, err := strconv.Atoi(b.HostPort); err == nil && n > 0 {
			return n
		}
	}
	return 0
}
