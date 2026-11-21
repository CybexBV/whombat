# Servers in the sidebar (2026-10-18)

John, 2026-10-18 (main checkout), after asking where Add a server is: “We should have a "Servers" item "With a + icon"
and the servers listed below it. We should NOT duplicate the servers under "Your Things"”. Before this the servers sat
first under YOUR THINGS (one-whombat-shell.md AP-1256, mock 1) and Add a server was only on the Servers page (AP-1318).

| # | Decision | Why |
|---|---|---|
| AP-1748 | **The assistant sidebar has a SERVERS section above YOUR THINGS**, styled like the other section labels: the heading “Servers” is a link to the Servers page (ink while it is the page), its `+` (“Add a server”) opens Add a server (`/things/servers?add=1`) and shows only for those who may add one (`hosts.status` `canManage`: owners, where the hosts service runs), and the servers are listed below it in the server's order with their status dots. **YOUR THINGS lists everything but the servers.** The section shows once there is a server or the Whombat runs the hosts service (a fresh box shows the heading and its `+` before the first server); a Whombat without servers shows no section. The phone is unchanged: its Things screen already has its own SERVERS section with Add a server at the end (server-signin-mobile.md AP-1698), and Home shows the servers as one row. | John's call; servers are the fleet and get the most attention, and Add a server was hard to find (it was only on the Servers page). The section label keeps the sidebar's existing look. |
