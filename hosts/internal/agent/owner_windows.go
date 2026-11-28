package agent

import "os"

// keepOwner: on Windows the folder's access list, which the new file
// inherits, decides who can read it (SecureDir).
func keepOwner(*os.File, os.FileInfo) {}
