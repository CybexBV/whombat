package agent

import "testing"

func TestWindowsVersionNames(t *testing.T) {
	for _, c := range []struct {
		v               WindowsVersion
		product, pretty string
		server          bool
	}{
		{WindowsVersion{ProductName: "Windows 10 Pro", DisplayVersion: "24H2", CurrentBuild: "26100", UBR: 2605, InstallationType: "Client"},
			"Windows 11 Pro", "Windows 11 Pro 24H2 (26100.2605)", false},
		{WindowsVersion{ProductName: "Windows 10 Home", DisplayVersion: "22H2", CurrentBuild: "19045", UBR: 5131, InstallationType: "Client"},
			"Windows 10 Home", "Windows 10 Home 22H2 (19045.5131)", false},
		{WindowsVersion{ProductName: "Windows Server 2025 Standard", DisplayVersion: "24H2", CurrentBuild: "26100", InstallationType: "Server Core"},
			"Windows Server 2025 Standard", "Windows Server 2025 Standard 24H2 (26100)", true},
		{WindowsVersion{}, "Windows", "Windows", false},
	} {
		if got := c.v.Product(); got != c.product {
			t.Errorf("Product() = %q, want %q", got, c.product)
		}
		if got := c.v.Pretty(); got != c.pretty {
			t.Errorf("Pretty() = %q, want %q", got, c.pretty)
		}
		if c.v.Server() != c.server {
			t.Errorf("%q Server() = %v", c.v.ProductName, !c.server)
		}
	}
}
