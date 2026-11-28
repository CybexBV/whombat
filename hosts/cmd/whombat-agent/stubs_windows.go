package main

import "errors"

// A Windows PC has no Mac screen, no supervisor of its own (the service
// manager restarts the agent), no local console tests and no package
// tasks: Windows Update installs are proposed, not run.

var errNotOnWindows = errors.New("this command isn't available on Windows")

func cmdScreen([]string) error       { return errNotOnWindows }
func screenUsage() string            { return "" }
func cmdSupervise([]string) error    { return errNotOnWindows }
func cmdConsoleTest([]string) error  { return errNotOnWindows }
func cmdDiagnoseTest([]string) error { return errNotOnWindows }
func cmdPackageTask([]string) error  { return errNotOnWindows }
