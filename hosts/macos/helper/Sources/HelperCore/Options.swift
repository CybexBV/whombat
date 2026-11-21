// The command line. Under its LaunchAgent the helper runs with no arguments and listens where the agent looks;
// the flags are for trying it by hand.

public struct Options: Equatable, Sendable {
    /// Where to listen; nil is the agent's place for this user.
    public var socket: String?
    /// Answer this one request line on standard output and stop, without a socket.
    public var request: String?
    public var version = false
    public var help = false

    public init(socket: String? = nil, request: String? = nil, version: Bool = false, help: Bool = false) {
        self.socket = socket
        self.request = request
        self.version = version
        self.help = help
    }

    public static let usage = """
        usage: WhombatHelper [--socket PATH] [--request JSON] [--version]

          (no flags)      listen on /var/run/whombat-agent/ui/<uid>/helper.sock, as the LaunchAgent runs it
          --socket PATH   listen on PATH instead (for trying it by hand; only root is answered there too)
          --request JSON  answer one request line on standard output, then stop (as root only)
          --version       print the version
        """

    /// Reads the arguments after the program's name. macOS adds `-psn_…` to apps started from the Finder, and
    /// `-NSSomething value` pairs reach every AppKit app; both are skipped.
    public static func parse(_ args: [String]) throws -> Options {
        var options = Options()
        var i = 0
        func value(_ flag: String) throws -> String {
            i += 1
            guard i < args.count, !args[i].isEmpty else { throw HelperError.invalid("\(flag) needs a value") }
            return args[i]
        }
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "--socket": options.socket = try value(arg)
            case "--request": options.request = try value(arg)
            case "--version", "-v": options.version = true
            case "--help", "-h": options.help = true
            default:
                if arg.hasPrefix("-psn_") { break }
                if arg.hasPrefix("-NS") || arg.hasPrefix("-Apple") {
                    i += 1
                    break
                }
                throw HelperError.invalid("unknown argument \(arg)")
            }
            i += 1
        }
        return options
    }
}
