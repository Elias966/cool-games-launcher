#!/usr/bin/env python3
"""Executed only inside the disposable bwrap rootfs by distro-smoke.sh."""
import http.server, json, os, shutil, signal, socket, sqlite3, struct, subprocess, sys, threading, time, urllib.request, zlib
from pathlib import Path

base = Path('/test'); shutil.rmtree(base/'tmp',ignore_errors=True); (base/'tmp').mkdir(exist_ok=True)
mode = sys.argv[1]
for folder in ['data', 'cache', 'config']: shutil.rmtree(base / folder, ignore_errors=True)
if (base / 'display').exists(): os.environ['DISPLAY'] = ':' + (base / 'display').read_text().strip()
def wait_for(fn, seconds=120):
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        try:
            result = fn()
            if result: return result
        except (OSError, sqlite3.Error): pass
        time.sleep(.25)
    raise RuntimeError('Timed out waiting for app/catalog')
def processes():
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid(): continue
        try: cmd = (proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
        except OSError: continue
        if any(s in cmd for s in ['cool-games-launcher.bin', '/firefox', '/geckodriver', '/llama-server', 'cgl-browser', 'cgl-inference', 'cgl-downloads', 'cgl-install']): found.append((int(proc.name), cmd))
    return found
log = (base / 'app.log').open('w')
weston = None
if mode == 'wayland':
    # Xvfb supplies a virtual input seat; Weston's pure headless backend has
    # none, which stalls GTK/Chromium startup before a window can be painted.
    weston = subprocess.Popen(['weston', '--backend=x11-backend.so', '--use-pixman', '--socket=wayland-cgl', '--idle-time=0', '--width=1480', '--height=920'], stdout=(base / 'weston.log').open('w'), stderr=subprocess.STDOUT)
    wait_for(lambda: (Path(os.environ['XDG_RUNTIME_DIR']) / 'wayland-cgl').exists(), 20)
    os.environ['WAYLAND_DISPLAY'] = 'wayland-cgl'
args = ['/launcher.AppImage', '--appimage-extract-and-run', '--no-sandbox']
if mode == 'wayland': args += ['--ozone-platform=wayland']
def start(): return subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
def stop(proc):
    main = [(pid, cmd) for pid, cmd in processes() if 'cool-games-launcher.bin' in cmd and '--type=' not in cmd]
    for pid, _ in main: os.kill(pid, signal.SIGTERM)
    try: proc.wait(timeout=25)
    except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); raise RuntimeError('App did not shut down')
    time.sleep(1)
    leftover = processes()
    if leftover: raise RuntimeError('Leftover worker processes: ' + repr(leftover))

# Initialize the schema with the production application before inserting a source.
proc = start()
db = base / 'data/cool-games-launcher/launcher.db'
def schema_ready():
    if not db.exists(): return False
    with sqlite3.connect(db) as connection: return connection.execute('SELECT version FROM schema_version').fetchone()[0] >= 2
wait_for(schema_ready)
wait_for(lambda: '[cgl] window ready' in (base / 'app.log').read_text(), 30)
# Optional agent weights must not ship in or download on first startup.
vendor = next((base / 'tmp').glob('appimage_extracted_*/resources/vendor'))
assert not list(vendor.rglob('*.gguf')), 'Language model unexpectedly bundled'
assert not list((base/'data').rglob('*.gguf')), 'Model downloaded without user action'
with sqlite3.connect(db) as connection:
    assert connection.execute('SELECT COUNT(*) FROM downloads').fetchone()[0] == 0
# The bundled decoder and CPU runtime must load in a clean userspace.
rar = subprocess.run([str(vendor/'7zip/7zzs'), 'x', '-so', '-y', '-bd', '-bb0', '--', '/test/decoder-fixture.rar'], capture_output=True)
assert rar.returncode == 0, rar.stderr.decode(errors='replace')
assert rar.stdout == b'test text document\r\ntest.txttest text document\r\n'
model_env = dict(os.environ, LD_LIBRARY_PATH=str(vendor/'llama/cpu')+':'+str(vendor/'llama/runtime/usr/lib/x86_64-linux-gnu'))
runtime = subprocess.run([str(vendor/'llama/cpu/llama-server'), '--version'],env=model_env,capture_output=True)
assert runtime.returncode == 0, runtime.stderr.decode(errors='replace')
stop(proc)

def png_chunk(kind, payload): return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress((b'\0' + b'\x10\x30\x60' * 64) * 64)) + png_chunk(b'IEND', b'')
class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/cover.png': self.send_response(200); self.send_header('Content-Type', 'image/png'); self.end_headers(); self.wfile.write(png); return
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
        self.wfile.write(b'<main><script type="application/ld+json">{"@type":"VideoGame","name":"Distro Smoke Orbit","description":"A space puzzle game","image":"/cover.png","operatingSystem":"Linux","genre":"Puzzle","keywords":"space"}</script><h1>Distro Smoke Orbit</h1><a href="/orbit-linux.zip">Download Linux build</a></main>')
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
source = 'http://127.0.0.1:%d/game' % server.server_port
with sqlite3.connect(db) as connection:
    connection.execute('INSERT OR IGNORE INTO sources (url,name,rate_limit_ms,max_pages) VALUES (?,?,?,?)', (source, 'Distro smoke fixture', 0, 1))
proc = start()
def waiting_for_model():
    return 'Download the browsing and analysis agents in Settings' in (base/'app.log').read_text()
# Missing-model state is also observable in the source, without attempting AI.
time.sleep(4)
with sqlite3.connect(db) as connection:
    assert connection.execute('SELECT COUNT(*) FROM catalog').fetchone()[0] == 0
    assert connection.execute('SELECT COUNT(*) FROM downloads').fetchone()[0] == 0
assert not list((base/'data').rglob('*.gguf'))
assert 'starting llama-server' not in (base/'app.log').read_text()
profile=base/'firefox-profile';profile.mkdir(exist_ok=True)
firefox=subprocess.run([str(vendor/'firefox/firefox'),'--headless','--no-remote','--profile',str(profile),'--screenshot','/test/firefox.png','--window-size','1280,800',source],env=dict(os.environ,MOZ_DISABLE_CONTENT_SANDBOX='1'),capture_output=True,timeout=45)
assert firefox.returncode==0,firefox.stderr.decode(errors='replace')
assert (base/'firefox.png').stat().st_size>300
stop(proc)
server.shutdown()
if weston: weston.terminate(); weston.wait(timeout=10)
result = {'mode':mode,'firefox':True,'optionalWeightsExcluded':True,'noAutomaticModelDownloads':True,'missingModelDoesNotRunInference':True,'cpuRuntimeLoads':True,'shutdownClean':True,'bundledRarDecoder':True}
(base / 'result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result), flush=True)
