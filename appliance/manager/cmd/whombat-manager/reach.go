package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/CybexBV/whombat/appliance/internal/environment"
	"github.com/CybexBV/whombat/appliance/internal/reach"
	"github.com/CybexBV/whombat/appliance/manager/internal/envmove"
)

// reachCmd is the recovery menu's “Change how you reach this Whombat” and “Turn on Tailscale” (LNK-12, LNK-15,
// LNK-06a): it writes the owner's choice, and the manager acts on it at its next start. Whoever is at the box's console
// can already read or erase its data, so it asks no more than the menu's other actions do.
func reachCmd(args []string) error {
	fs := flag.NewFlagSet("reach", flag.ContinueOnError)
	file := fs.String("file", reach.File, "the choice on the mounted data volume")
	if len(args) == 0 {
		return errors.New("usage: whombat-manager reach link|tailscale|tailscale-on [--file F]")
	}
	change := args[0]
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if _, err := reach.Change(*file, change, time.Now()); err != nil {
		return err
	}
	switch change {
	case reach.UseLink:
		fmt.Println("This Whombat will use Whombat Link. Its screen shows what to do next once it runs again.")
	case reach.UseTailscale:
		fmt.Println("This Whombat will use Tailscale, and Whombat Link goes off. Its screen shows Tailscale's sign-in link once it runs again.")
	case reach.TailscaleOn:
		fmt.Println("Tailscale goes on once this Whombat runs again. Its screen shows Tailscale's sign-in link if it needs one.")
	}
	return nil
}

// environmentCmd shows or sets the box's environment (LNK-01a). `set <env>` moves the box there (ONE-06,
// manager/internal/envmove): its identity's env, the kept registration and, when the control changes, its Link and own
// address start again; it refuses while the manager runs. `set dev --if-absent` is the bridge release's one-shot for
// Cybex's development boxes: it writes only the environment file, never over a choice already made. `write-run` is
// whombat-environment.service.
func environmentCmd(args []string) error {
	fs := flag.NewFlagSet("environment", flag.ContinueOnError)
	image := fs.String("image", environment.ImageFile, "the image's environments")
	box := fs.String("file", environment.BoxFile, "the box's choice")
	run := fs.String("run", environment.RunDir, "where the resolved environment goes (write-run)")
	ifAbsent := fs.Bool("if-absent", false, "set: only the environment file, and keep a choice already made")
	paths := envmove.DefaultPaths()
	fs.StringVar(&paths.IdentityDir, "identity", paths.IdentityDir, "set: the identity's folder")
	fs.StringVar(&paths.ManagerDir, "manager-dir", paths.ManagerDir, "set: the manager's state folder")
	fs.StringVar(&paths.Moves, "moves-dir", paths.Moves, "set, write-run: root's folder of environment moves")
	socket := fs.String("socket", "/run/whombat-manager/api.sock", "set: refused while a manager answers here")
	if len(args) == 0 {
		return errors.New("usage: whombat-manager environment show|set <env> [--if-absent]|undo|recover|write-run")
	}
	verb, rest := args[0], args[1:]
	var name string
	if verb == "set" {
		if len(rest) == 0 {
			return errors.New("usage: whombat-manager environment set <env> [--if-absent]")
		}
		name, rest = rest[0], rest[1:]
	}
	if err := fs.Parse(rest); err != nil {
		return err
	}
	switch verb {
	case "show":
		r, err := environment.Resolve(*image, *box)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(r)
	case "set":
		if *ifAbsent {
			wrote, err := environment.Set(*image, *box, name, true)
			if err != nil {
				return err
			}
			if wrote {
				fmt.Printf("This Whombat uses the %s environment from its next start.\n", name)
			} else {
				fmt.Println("Nothing was changed.")
			}
			return nil
		}
		if c, err := net.DialTimeout("unix", *socket, time.Second); err == nil {
			c.Close()
			return errors.New("the manager is running: stop it first (systemctl stop whombat-manager), then start it again after the move")
		}
		paths.Image, paths.Box = *image, *box
		res, err := envmove.Move(paths, name, time.Now())
		if err != nil {
			return err
		}
		printMove(res)
		return nil
	case "undo":
		// The newest finished move, back from its own copies (MG-178); the manager stopped, as for set.
		if c, err := net.DialTimeout("unix", *socket, time.Second); err == nil {
			c.Close()
			return errors.New("the manager is running: stop it first (systemctl stop whombat-manager), then start it again after the undo")
		}
		paths.Image, paths.Box = *image, *box
		res, err := envmove.Undo(paths)
		if err != nil {
			return err
		}
		fmt.Printf("The move from the %s to the %s environment is undone: this Whombat is back in the %s environment at its next start.\n",
			res.From, res.To, res.From)
		if res.Adopted {
			fmt.Printf("Its identity is again the one its old control made (route %s).\n", res.RouteFrom)
		}
		return nil
	case "recover":
		// whombat-environment-move.service, at boot before anything reads the environment (R1 #13, R2 A9): a move that
		// stopped is finished or undone; otherwise this fails, the move's record stays, and the units that need the
		// environment (the manager first) don't start.
		paths.Image, paths.Box = *image, *box
		msg, err := envmove.BootCheck(paths)
		if err != nil {
			fmt.Fprintf(os.Stderr, "whombat-manager: %v\n", err)
			return err
		}
		if msg != "" {
			fmt.Println(msg)
		}
		return nil
	case "write-run":
		// Never while a move is under way: the environment file and the identity may not agree (R2 A9).
		paths.Image, paths.Box = *image, *box
		if pending, err := envmove.Pending(paths); err != nil || pending {
			problem := errors.Join(err, errors.New("an environment move is under way (whombat-manager environment recover finishes or undoes it)"))
			if werr := environment.WriteProblem(*run, problem); werr != nil {
				return errors.Join(problem, werr)
			}
			return problem
		}
		r, err := environment.Resolve(*image, *box)
		if err != nil {
			// Never the default instead: the box runs without Link until its file is fixed (and the unit says why).
			if werr := environment.WriteProblem(*run, err); werr != nil {
				return errors.Join(err, werr)
			}
			return err
		}
		return environment.WriteRun(r, *run)
	}
	return fmt.Errorf("unknown environment command %q", verb)
}

// printMove says what a move did, in plain words.
func printMove(r *envmove.Result) {
	if !r.Changed() {
		fmt.Println("Nothing was changed.")
		return
	}
	fmt.Printf("This Whombat moves from the %s to the %s environment at its next start.\n", r.From, r.To)
	if r.IdentityTo != "" {
		fmt.Printf("Its identity now says %s (it said %s). Its device id, keys and data stay.\n", r.IdentityTo, r.IdentityFrom)
	}
	if r.Registration {
		fmt.Println("Its kept registration is signed again for that.")
	}
	if r.Adopted {
		fmt.Printf("Its identity, which its old control made (route %s), is now its own: the same device id and keys.\n", r.RouteFrom)
	}
	if r.SetAside != "" {
		fmt.Printf("Whombat Link and its own address start again at the new control: turn Link on once it runs.\n"+
			"The old state is kept in %s.\n", r.SetAside)
	}
}
