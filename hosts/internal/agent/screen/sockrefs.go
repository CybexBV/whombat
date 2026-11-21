package screen

import "fmt"

// unixSock is what the kernel says of one Unix socket descriptor.
type unixSock struct {
	so, conn uint64 // its handle and that of the socket it is connected to
	shared   bool   // its open file has other references
}

// holderRefs finds, among a process's socket descriptors (list), those of
// the socket connected to the agent's end near, each with whether its open
// file has other references. Every socket descriptor must be read: one the
// kernel won't describe could be the connection held a second time, so the
// list is read again once (a descriptor closed meanwhile is gone from it),
// and when one still can't be read nothing is answered.
func holderRefs(pid int, near unixSock, list func() ([]int, error), read func(fd int) (unixSock, bool, error)) ([]sockRef, error) {
	var unread error
	for try := 0; try < 2; try++ {
		fds, err := list()
		if err != nil {
			return nil, err
		}
		var refs []sockRef
		unread = nil
		for _, fd := range fds {
			sock, ok, err := read(fd)
			switch {
			case err != nil:
				unread = err
			case ok && sock.so == near.conn:
				refs = append(refs, sockRef{fd: fd, shared: sock.shared || sock.conn != near.so})
			}
		}
		if unread == nil {
			return refs, nil
		}
	}
	return nil, fmt.Errorf("can't account for every descriptor of process %d: %w", pid, unread)
}
