package dest

import (
	"encoding/json"
	"time"
)

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func sleep() { time.Sleep(25 * time.Millisecond) }
