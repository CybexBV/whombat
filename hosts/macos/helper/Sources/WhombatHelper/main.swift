import AppKit
import ApplicationServices
import HelperCore

// Whombat Helper: started by the LaunchAgent com.whombat.helper in each desktop session, it answers whombat-agent's
// requests to find, press and type into what is on the screen (README.md). It has no Dock icon and no windows.

let options: Options
do {
    options = try Options.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    let message = (error as? HelperError)?.message ?? "\(error)"
    FileHandle.standardError.write(Data("WhombatHelper: \(message)\n\(Options.usage)\n".utf8))
    exit(2)
}
if options.help {
    print(Options.usage)
    exit(0)
}
if options.version {
    print(Helper.version)
    exit(0)
}

// One stuck app must not hold a request up for long: every Accessibility call waits at most this.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), AX.messagingTimeout)
// A client that hangs up early must not end the helper.
signal(SIGPIPE, SIG_IGN)

if let request = options.request {
    // Answering a command line would let any program of this user drive the Accessibility the person gave Whombat
    // Helper (started through `open`, macOS counts it as the helper's own): only root may.
    guard getuid() == 0 else {
        FileHandle.standardError.write(Data("WhombatHelper: --request is for root only\n".utf8))
        exit(2)
    }
    let answer = Helper.respond(Data(request.utf8), deadline: Date().addingTimeInterval(Limits.workSeconds))
    FileHandle.standardOutput.write(answer.line())
    if case .failure = answer { exit(1) }
    exit(0)
}

let server = SocketServer(path: options.socket ?? SocketServer.defaultPath(), log: { Log.info($0) }) { line, deadline in
    Helper.respond(line, deadline: deadline).line()
}
Thread.detachNewThread { server.run() }

// launchd stops the helper with SIGTERM (a log-out, an uninstall): the socket goes with it, so the agent knows at once.
let stopSignals = [SIGTERM, SIGINT].map { sig in
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        server.stop()
        exit(0)
    }
    source.resume()
    return source
}

// macOS naps an app without windows, and a napped app's run loop lags: NSWorkspace's view of the apps (which app
// is in front) would go stale. The helper answers for the person's session, so it opts out, as an app doing what
// the person asked does; the Mac still sleeps when idle.
let awake = ProcessInfo.processInfo.beginActivity(
    options: [.userInitiatedAllowingIdleSystemSleep], reason: "Answers whombat-agent for the person at the screen")

// The app's run loop keeps NSWorkspace's view of running apps current.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
