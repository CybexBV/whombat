//go:build !windows

package winpc

import "rackoon/internal/proto"

// services: the service manager is Windows'.
func services() ([]proto.Service, error) { return nil, errNotWindows }
