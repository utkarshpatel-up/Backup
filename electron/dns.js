'use strict';
// Set the DNS of the ACTIVE network connection to Cloudflare (1.1.1.1 / 1.0.0.1).
//   macOS:   `route -n get default` -> device -> `networksetup -listnetworkserviceorder` -> service,
//            then `networksetup -setdnsservers` + dscacheutil/mDNSResponder flush, via an osascript admin prompt.
//   Windows: Get-NetRoute (lowest route+interface metric wins) -> adapter, then
//            Set-DnsClientServerAddress + Clear-DnsClientCache, via a UAC-elevated PowerShell.
// Only the two scoped commands are elevated; discovery and verification run unprivileged.
// Anything ambiguous (VPN, tie, adapter down, unknown name) throws instead of guessing.
const { execFile } = require('node:child_process');

const SERVERS = ['1.1.1.1', '1.0.0.1'];
const VPN_LIKE = /vpn|tap-|tun|wireguard|ppp|tailscale|zerotier|openvpn|anyconnect|globalprotect|virtual|vmware|hyper-v|vethernet|loopback/i;
const MAC_DEVICE = /^en\d{1,3}$/;
const SERVICE_NAME = /^[^\u0000-\u001f\u007f]{1,100}$/;

class DnsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function defaultRun(file, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
    });
  });
}

const sameServers = (list) => Array.isArray(list) && list.length === SERVERS.length && list.every((s, i) => s === SERVERS[i]);

// ---------------------------------------------------------------- macOS

/** The Wi-Fi/Ethernet device carrying the default route, e.g. 'en0'. Anything else (utun VPN...) is refused. */
function macDevice(routeOutput) {
  const m = /^\s*interface:\s*(\S+)\s*$/m.exec(String(routeOutput));
  if (!m) throw new DnsError('no_route', 'No active network connection was found.');
  if (!MAC_DEVICE.test(m[1])) {
    throw new DnsError('ambiguous', `The active connection is "${m[1].slice(0, 20)}" (a VPN or virtual interface). Turn it off or change DNS manually in System Settings.`);
  }
  return m[1];
}

/** Network service name for a device, from `networksetup -listnetworkserviceorder`; disabled (*) services never match. */
function macService(listOutput, device) {
  const hits = [];
  let name = null;
  for (const line of String(listOutput).split('\n')) {
    const head = /^\((\d+|\*)\)\s+(.+?)\s*$/.exec(line);
    // networksetup marks a disabled service as "(*) Name" or "(3) *Name"; refuse both.
    if (head) { name = head[1] === '*' || head[2].startsWith('*') ? null : head[2]; continue; }
    const port = /^\(Hardware Port: .*, Device: (\S+)\)\s*$/.exec(line.trim());
    if (port && name && port[1] === device) hits.push(name);
  }
  if (hits.length !== 1) {
    throw new DnsError(hits.length ? 'ambiguous' : 'no_service',
      hits.length ? `More than one network service uses ${device}; change DNS manually.` : `No enabled network service uses ${device}.`);
  }
  if (!SERVICE_NAME.test(hits[0])) throw new DnsError('bad_service', 'The network service name is not safe to use.');
  return hits[0];
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const asQuote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function macElevatedScript(service) {
  return `do shell script ${asQuote(`/usr/sbin/networksetup -setdnsservers ${shQuote(service)} ${SERVERS.join(' ')} && /usr/bin/dscacheutil -flushcache && /usr/bin/killall -HUP mDNSResponder`)} with administrator privileges`;
}

async function macSet(run) {
  const device = macDevice((await run('/sbin/route', ['-n', 'get', 'default'])).stdout);
  const service = macService((await run('/usr/sbin/networksetup', ['-listnetworkserviceorder'])).stdout, device);
  try { await run('/usr/bin/osascript', ['-e', macElevatedScript(service)], { timeout: 120000 }); }
  catch (e) {
    if (/user canceled|\(-128\)/i.test(`${e.stderr || ''}${e.message}`)) throw new DnsError('denied', 'Administrator permission was not given. DNS was not changed.');
    throw new DnsError('failed', `Could not finish changing DNS; it may have partly changed. ${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
  const now = (await run('/usr/sbin/networksetup', ['-getdnsservers', service])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!sameServers(now)) throw new DnsError('verify', `DNS for "${service}" did not read back as Cloudflare; it may have changed. Check System Settings.`);
  return { adapter: service };
}

// ---------------------------------------------------------------- Windows

const WIN_ROUTES = "$ErrorActionPreference='Stop';$r=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0'|ForEach-Object{$i=Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4;$a=Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue;[pscustomobject]@{index=[int]$_.InterfaceIndex;alias=[string]$a.Name;status=[string]$a.Status;virtual=[bool]$a.Virtual;desc=[string]$a.InterfaceDescription;metric=[int]($_.RouteMetric+$i.InterfaceMetric)}});ConvertTo-Json -InputObject $r -Compress";
const winVerify = (index) => `$ErrorActionPreference='Stop';ConvertTo-Json -InputObject @((Get-DnsClientServerAddress -InterfaceIndex ${index} -AddressFamily IPv4).ServerAddresses) -Compress`;
const winElevated = (index) => `try{Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses ('${SERVERS.join("','")}') -ErrorAction Stop;Clear-DnsClientCache -ErrorAction Stop}catch{exit 1}`;

/** The one adapter holding the best default route; refuses ties, down, virtual and VPN-like adapters. */
function winAdapter(json) {
  let routes;
  try { routes = JSON.parse(json); } catch (_) { throw new DnsError('no_route', 'Could not read the active network connection.'); }
  routes = (Array.isArray(routes) ? routes : [routes]).filter((r) => r && Number.isInteger(r.index) && r.index > 0 && Number.isFinite(r.metric));
  if (!routes.length) throw new DnsError('no_route', 'No active network connection was found.');
  const best = Math.min(...routes.map((r) => r.metric));
  const top = routes.filter((r) => r.metric === best);
  if (new Set(top.map((r) => r.index)).size > 1) throw new DnsError('ambiguous', 'Two connections are equally active; change DNS manually for the one you want.');
  const a = top[0];
  if (a.status !== 'Up') throw new DnsError('ambiguous', 'The active connection is not up.');
  if (a.virtual || VPN_LIKE.test(`${a.alias} ${a.desc}`)) {
    throw new DnsError('ambiguous', `The active connection "${String(a.alias).slice(0, 40)}" looks like a VPN or virtual adapter. Turn it off or change DNS manually.`);
  }
  return { index: a.index, alias: String(a.alias) };
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Windows PowerShell by absolute path under the system directory — never found through PATH or the current directory. */
function winPowerShell(env = process.env) {
  const root = /^[A-Za-z]:\\[^"'`$;&|<>%\r\n]*$/.test(env.SystemRoot || '') ? env.SystemRoot.replace(/\\+$/, '') : 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

async function winSet(run, ps = winPowerShell()) {
  const { index, alias } = winAdapter((await run(ps, [...PS, WIN_ROUTES])).stdout);
  const encoded = Buffer.from(winElevated(index), 'utf16le').toString('base64');
  const outer = `$p=Start-Process -FilePath '${ps}' -WorkingDirectory (Split-Path '${ps}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}';exit $p.ExitCode`;
  // 1223 (ERROR_CANCELLED) is only exited for a declined UAC prompt; any other Start-Process failure exits 1 with its message.
  const guarded = `try{${outer}}catch{$w=$_.Exception;while($w.InnerException){$w=$w.InnerException};if($w.NativeErrorCode -eq 1223){exit 1223};[Console]::Error.WriteLine($_.Exception.Message);exit 1}`;
  try { await run(ps, [...PS, guarded], { timeout: 120000 }); }
  catch (e) {
    if (e.code === 1223) throw new DnsError('denied', 'Administrator permission was not given. DNS was not changed.');
    throw new DnsError('failed', `Could not finish changing DNS; it may have partly changed. ${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
  let now;
  try { now = JSON.parse((await run(ps, [...PS, winVerify(index)])).stdout); } catch (_) { now = null; }
  if (!sameServers(now)) throw new DnsError('verify', `DNS for "${alias}" did not read back as Cloudflare; it may have changed. Check Network settings.`);
  return { adapter: alias };
}

/** Resolves {adapter} only after DNS is read back as exactly Cloudflare; otherwise throws DnsError(code). */
async function setCloudflareDns({ platform = process.platform, run = defaultRun, powershell } = {}) {
  if (platform === 'darwin') return macSet(run);
  if (platform === 'win32') return winSet(run, powershell);
  throw new DnsError('unsupported', 'Setting DNS from the app is only available on Windows and macOS.');
}

/**
 * Whole feature: refuse if unsafe, confirm, change DNS, flush edits through the close handshake, relaunch.
 * DNS goes first so a denied/failed change leaves the window untouched; the relaunch needs verified DNS
 * AND an approved flush. Returns {ok} or {ok:false, code, error}; on ok the app is already relaunching.
 */
async function dnsAndRestart({ platform = process.platform, isBusy, closer, confirm, setDns = setCloudflareDns, relaunch }) {
  const fail = (code, error) => ({ ok: false, code, error });
  if (platform !== 'darwin' && platform !== 'win32') return fail('unsupported', 'Setting DNS from the app is only available on Windows and macOS.');
  if (isBusy() || closer.pending) return fail('busy', 'Finish or cancel the running backup or task first.');
  if (!await confirm()) return fail('cancelled', 'Cancelled.');
  if (isBusy() || closer.pending) return fail('busy', 'Finish or cancel the running backup or task first.');
  try { await setDns({ platform }); } catch (e) { return fail(e.code || 'failed', e.message); }
  // Strict: never offers "quit without saving" and never marks the shared close as approved.
  const saved = !isBusy() && await closer.flushStrict();
  if (!saved || isBusy()) {
    if (saved) closer.cancelled();   // a task started while saving: give the editor back
    return fail('not_restarted', 'DNS is now Cloudflare, but the app was not restarted because pending changes were not saved or a task started. Restart it yourself once that is sorted.');
  }
  relaunch();
  return { ok: true };
}

module.exports = { winPowerShell, dnsAndRestart, setCloudflareDns, DnsError, macDevice, macService, macElevatedScript, winAdapter, SERVERS };
