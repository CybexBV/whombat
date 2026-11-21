package broker

import (
	"errors"
	"net/http"

	"github.com/CybexBV/whombat/appliance/manager/internal/updatechannel"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The update channel (Whombat LNK-21, LNK-42; contracts 4.4.0 updateChannel, updateChannelSet): the runtime's only,
// like Ask before updating's switch. The runtime has checked the owner's signed `updates.channel.set`; the helper
// keeps the channel and activates only its newest release, forward only.

// channelBodyMax bounds both requests: {v} or {v, channel}.
const channelBodyMax = 1024

func (s *Server) channelErr(w http.ResponseWriter, err error) {
	if errors.Is(err, updatechannel.ErrNoChannels) || s.Channel == nil {
		writeErr(w, http.StatusNotFound, local.LinkErrorUpdateChannelUnavailable, "this box has no update channels")
		return
	}
	writeErr(w, http.StatusInternalServerError, "internal", err.Error())
}

func (s *Server) updateChannel(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseUpdateChannelRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.Channel == nil {
		s.channelErr(w, nil)
		return
	}
	res, err := s.Channel.Response(r.Context())
	if err != nil {
		s.channelErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) updateChannelSet(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseUpdateChannelSetRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.Channel == nil {
		s.channelErr(w, nil)
		return
	}
	if _, err := s.Channel.Set(r.Context(), string(req.Channel)); err != nil {
		s.channelErr(w, err)
		return
	}
	s.log().Info("update channel", "channel", req.Channel)
	res, err := s.Channel.Response(r.Context())
	if err != nil {
		s.channelErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
