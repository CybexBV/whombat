package hub

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"strings"
	"text/template"
)

// A Windows PC installs the agent with one line in PowerShell opened as
// administrator (Whombat docs/decisions/windows-servers.md). Windows doesn't
// know the hub's certificate authority, and PowerShell has no way to pin a
// key, so the line trusts content instead of the connection: it carries
// install.ps1's SHA-256 and runs the script only when the download
// matches; the script carries the agent builds' SHA-256s the same way, and
// the agent enrolls with the authority's pin, as on Linux.

// windowsInstallScript renders install.ps1: the same bytes for every
// request until the hub's authority or its Windows builds change, so the
// line made for an enrollment matches the script served an hour later.
func (h *Hub) windowsInstallScript() (script []byte, ok bool) {
	data := map[string]string{"Pin": h.ca.Pin, "SumAMD64": "", "SumARM64": ""}
	if h.cfg.AgentDist != "" {
		data["SumAMD64"] = fileSHA256(filepath.Join(h.cfg.AgentDist, agentFileName("windows", "amd64")))
		data["SumARM64"] = fileSHA256(filepath.Join(h.cfg.AgentDist, agentFileName("windows", "arm64")))
	}
	var b bytes.Buffer
	if err := installPS1Tmpl.Execute(&b, data); err != nil {
		h.log.Error("install.ps1", "err", err)
		return nil, false
	}
	return b.Bytes(), data["SumAMD64"] != "" || data["SumARM64"] != ""
}

// serveInstallPS1 serves install.ps1 (it names no address: the line passes
// them, so the script is the same from either listener).
func (h *Hub) serveInstallPS1(w http.ResponseWriter, r *http.Request) {
	script, _ := h.windowsInstallScript()
	if script == nil {
		http.Error(w, "install.ps1 is unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(script)
}

// installCommandWindows is the Windows PC's line: download install.ps1
// from origin, check its SHA-256, run it with the agents' URL, the token
// and the control level. "" when the hub has no Windows build of the
// agent (Whombat then says it can't add a Windows PC yet).
func (h *Hub) installCommandWindows(r *http.Request, token, control string) (string, error) {
	origin := h.requestOrigin(r)
	hubURL, err := h.agentURL(r)
	if h.cfg.Headless {
		if origin, err = h.agentInstallBase(); err != nil {
			return "", err
		}
		hubURL, err = h.agentURL(nil)
	}
	if err != nil {
		return "", err
	}
	script, ok := h.windowsInstallScript()
	if !ok {
		return "", nil
	}
	sum := sha256.Sum256(script)
	return windowsLine(origin, hubURL, hex.EncodeToString(sum[:]), token, control), nil
}

// windowsLine is the PowerShell line (Windows PowerShell 5.1 and
// PowerShell 7). Every value in it is one the hub made or checked: an
// origin and a URL of safe hosts, a hex digest, a base64url token, a
// control level.
//
// Windows PowerShell can switch the certificate check off only for the
// whole session, so the line keeps the session's own check and protocols,
// switches them for the one download and puts them back in a finally,
// before it looks at what came. On a mismatch it says so and runs nothing;
// it doesn't exit, which would close the window before the message is read.
func windowsLine(origin, hubURL, sum, token, control string) string {
	run := "-Origin $u -Hub " + psString(hubURL) + " -Token " + psString(token)
	if control != "" {
		run += " -Control " + psString(control)
	}
	const spm = "[Net.ServicePointManager]::"
	return "$u=" + psString(origin) + ";$s=" + psString(sum) + ";$o=@{};$d=$PSVersionTable.PSEdition -ne 'Core';" +
		"if($d){$p=" + spm + "SecurityProtocol;$c=" + spm + "ServerCertificateValidationCallback;" +
		spm + "SecurityProtocol=3072;" + spm + "ServerCertificateValidationCallback={$true}}else{$o.SkipCertificateCheck=$true};" +
		"try{$b=(Invoke-WebRequest -UseBasicParsing -DisableKeepAlive @o \"$u/install.ps1\").RawContentStream.ToArray()}" +
		"finally{if($d){" + spm + "SecurityProtocol=$p;" + spm + "ServerCertificateValidationCallback=$c}};" +
		"if((-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|%{$_.ToString('x2')})) -ne $s)" +
		"{'whombat-agent: the installer did not match. Copy the line from Whombat again.'}" +
		"else{&([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) " + run + "}"
}

// WindowsUninstallLine removes the agent from a Windows PC (and keeps its
// identity, as install.sh --uninstall does).
const WindowsUninstallLine = `& "$env:ProgramFiles\Whombat\whombat-agent.exe" uninstall`

// psString quotes s for a single-quoted PowerShell string.
func psString(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

var installPS1Tmpl = template.Must(template.New("install.ps1").Parse(`# Whombat agent installer for Windows, from Whombat's hosts service.
# Whombat's Add a server gives the line that runs it in PowerShell opened as
# administrator: the line checks this script's SHA-256 and passes -Origin
# (where the agent downloads from), -Hub (where it reports), -Token (the
# one-time code) and -Control (watch, operate or full).
# Running it again upgrades the agent and keeps the PC's identity; a PC that
# reports to another Whombat is left alone unless -Force.
param(
	[Parameter(Mandatory = $true)][string]$Origin,
	[Parameter(Mandatory = $true)][string]$Hub,
	[string]$Token = '',
	[string]$Control = '',
	[switch]$Force
)

$CASHA256 = '{{.Pin}}'
$Sums = @{ AMD64 = '{{.SumAMD64}}'; ARM64 = '{{.SumARM64}}' }
$Service = 'whombat-agent'
$Dir = Join-Path $env:ProgramFiles 'Whombat'
$Agent = Join-Path $Dir 'whombat-agent.exe'
$Download = Join-Path $Dir 'whombat-agent-download.exe'
$ConfigDir = Join-Path $env:ProgramData 'Whombat\agent'

# Downloads from the hub. Windows doesn't know Whombat's own certificate
# authority, so the connection isn't checked; the file is, by its SHA-256.
# Windows PowerShell can switch the check off only for the whole session:
# it is off for this one download and goes back to what it was after it.
function Get-WhombatFile([string]$Url, [string]$OutFile) {
	$o = @{ UseBasicParsing = $true; DisableKeepAlive = $true; Uri = $Url; OutFile = $OutFile; ErrorAction = 'Stop' }
	if ($PSVersionTable.PSEdition -eq 'Core') {
		Invoke-WebRequest @o -SkipCertificateCheck
		return
	}
	$protocols = [Net.ServicePointManager]::SecurityProtocol
	$check = [Net.ServicePointManager]::ServerCertificateValidationCallback
	try {
		[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
		[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
		Invoke-WebRequest @o
	} finally {
		[Net.ServicePointManager]::SecurityProtocol = $protocols
		[Net.ServicePointManager]::ServerCertificateValidationCallback = $check
	}
}

# What the agent prints, without its errors.
function Read-Agent([string]$Exe, [string[]]$Arguments) {
	"$(& $Exe @Arguments 2>$null)"
}

function Install-WhombatAgent {
	$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
	if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
		return 'Open PowerShell as administrator and paste the line again.'
	}
	if ([Environment]::OSVersion.Version.Major -lt 10) {
		return 'Whombat needs Windows 10 or later.'
	}
	$arch = $env:PROCESSOR_ARCHITEW6432
	if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
	$arch = "$arch".ToUpperInvariant()
	if (-not $Sums.ContainsKey($arch)) {
		return "Whombat's agent runs on 64-bit Intel, AMD and Arm PCs; this one is $arch."
	}
	$sum = $Sums[$arch]
	if (-not $sum) {
		return 'This Whombat has no Windows agent for this PC yet. Update Whombat and try again.'
	}
	if ($Control -and @('watch', 'operate', 'full') -notcontains $Control) {
		return '-Control must be watch, operate or full.'
	}
	$goarch = $arch.ToLowerInvariant()

	New-Item -ItemType Directory -Force -Path $Dir -ErrorAction Stop | Out-Null
	Write-Host "Downloading the Whombat agent ($goarch) ..."
	Get-WhombatFile "$Origin/download/whombat-agent-windows-$goarch.exe" $Download
	$got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Download -ErrorAction Stop).Hash.ToLowerInvariant()
	if ($got -ne $sum) {
		Remove-Item -Force -LiteralPath $Download
		return 'The download did not match its checksum. Try again.'
	}

	# An agent of this Whombat (the same authority) keeps its identity; one
	# of another Whombat is left alone unless -Force.
	$mode = 'enroll'
	$forceEnroll = [bool]$Force
	if ((Test-Path -LiteralPath (Join-Path $ConfigDir 'agent.crt')) -and -not $Force) {
		$who = (Read-Agent $Download @('whoami')).Split(' ')
		if ($who.Count -ge 2 -and $who[1] -eq $CASHA256) {
			$mode = 'keep'
		} else {
			Remove-Item -Force -LiteralPath $Download
			return 'This PC reports to another Whombat. Remove its agent there first, or run this again with -Force to move it here.'
		}
	}
	if ($mode -eq 'enroll' -and -not $Token) {
		Remove-Item -Force -LiteralPath $Download
		return 'The one-time code is missing. Copy the line from Whombat again.'
	}

	$svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
	if ($svc -and $svc.Status -ne 'Stopped') {
		Write-Host 'Stopping the agent ...'
		Stop-Service -Name $Service -Force -ErrorAction Stop
		$svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
	}
	Move-Item -Force -LiteralPath $Download -Destination $Agent -ErrorAction Stop

	if ($mode -eq 'keep' -and $Token) {
		# The same Whombat may have removed this PC (or let its certificate
		# expire): then the identity is dead, enroll again.
		$state = (Read-Agent $Agent @('whoami', '--check', '--hub', $Hub)).Split(' ')
		if ($state.Count -ge 3 -and $state[2] -eq 'removed') {
			Write-Host 'Whombat no longer knows this PC, so it enrolls again.'
			$mode = 'enroll'
			$forceEnroll = $true
		}
	}
	if ($mode -eq 'enroll') {
		Write-Host "Enrolling with $Hub ..."
		$a = @('enroll', '--hub', $Hub, '--ca-sha256', $CASHA256, '--token', '-')
		if ($forceEnroll) { $a += '--force' }
		$Token | & $Agent @a | Out-Host
		if ($LASTEXITCODE -ne 0) { return 'Enrolling failed (see above).' }
	} else {
		Write-Host "Keeping this PC's Whombat identity and settings."
		& $Agent hub $Hub --no-restart | Out-Null
	}
	if ($Control) {
		& $Agent policy set $Control --no-reload | Out-Null
	}
	& $Agent service install | Out-Host
	if ($LASTEXITCODE -ne 0) { return 'Setting up the agent service failed (see above).' }
	& $Agent service start | Out-Host
	if ($LASTEXITCODE -ne 0) { return 'The agent service did not start (see above).' }
	if ($mode -eq 'enroll') { return "Done: $env:COMPUTERNAME is in Whombat now." }
	return "Done: the Whombat agent on $env:COMPUTERNAME is up to date."
}

try {
	$result = Install-WhombatAgent
} catch {
	$result = "Something went wrong: $($_.Exception.Message)"
}
Write-Host $result
`))
