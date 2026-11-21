package controlapi

import "encoding/base64"

func b64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }
