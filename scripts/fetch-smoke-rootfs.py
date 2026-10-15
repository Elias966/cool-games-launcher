#!/usr/bin/env python3
"""Pull official amd64 OCI rootfs layers, verifying every digest before extraction.
No Docker daemon, host package installs, privileged mounts or root are required.
"""
import hashlib, json, os, posixpath, shutil, sys, tarfile, urllib.parse, urllib.request
from pathlib import Path

name, cache_arg = sys.argv[1:]
images = {'ubuntu22': ('registry-1.docker.io', 'library/ubuntu', '22.04'),
          'ubuntu24': ('registry-1.docker.io', 'library/ubuntu', '24.04'),
          'debian12': ('registry-1.docker.io', 'library/debian', 'bookworm-slim'),
          'fedora42': ('registry.fedoraproject.org', 'fedora', '42')}
registry, repository, tag = images[name]
cache = Path(cache_arg).resolve(); cache.mkdir(parents=True, exist_ok=True)
root = cache / name
if (root / '.cgl-rootfs-ready').exists(): sys.exit(0)
headers = {'User-Agent': 'Cool-Games-Launcher-smoke', 'Accept': ', '.join([
    'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])}
if registry.endswith('docker.io'):
    token_url = 'https://auth.docker.io/token?' + urllib.parse.urlencode({'service':'registry.docker.io', 'scope':f'repository:{repository}:pull'})
    with urllib.request.urlopen(token_url, timeout=60) as response: token = json.load(response)['token']
    headers['Authorization'] = 'Bearer ' + token
base = f'https://{registry}/v2/{repository}'
def get_json(path):
    with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=90) as response:
        raw = response.read(); digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
        return json.loads(raw), digest
manifest, digest = get_json('/manifests/' + tag)
if 'manifests' in manifest:
    selected = next(m for m in manifest['manifests'] if m.get('platform', {}).get('architecture') == 'amd64' and m['platform'].get('os') == 'linux')
    manifest, digest = get_json('/manifests/' + selected['digest'])
    if digest != selected['digest']: raise RuntimeError('Manifest digest mismatch')
root.mkdir(parents=True, exist_ok=True)
for directory, children, _ in os.walk(root):
    os.chmod(directory, os.stat(directory).st_mode | 0o700)

def rooted(member, follow_final=True):
    """Resolve symlinks as the guest would, including absolute guest symlinks."""
    parts = member.lstrip('/').split('/'); done = []; hops = 0
    while parts:
        part = parts.pop(0)
        if part in ('', '.'): continue
        if part == '..':
            if not done: raise RuntimeError('Rootfs path escapes root')
            done.pop(); continue
        candidate = root.joinpath(*done, part)
        if candidate.is_symlink() and (parts or follow_final):
            hops += 1
            if hops > 40: raise RuntimeError('Rootfs symlink loop')
            target = os.readlink(candidate)
            if target.startswith('/'): done = []
            parts = target.split('/') + parts
        else: done.append(part)
    return root.joinpath(*done)

def remove(path):
    if path.is_symlink() or path.is_file(): path.unlink()
    elif path.exists(): shutil.rmtree(path)

for layer in manifest['layers']:
    expected = layer['digest']; algorithm, hash_value = expected.split(':', 1)
    if algorithm != 'sha256': raise RuntimeError('Unsupported layer digest')
    archive = cache / (hash_value + '.layer')
    if not archive.exists():
        temp = archive.with_suffix('.part')
        with urllib.request.urlopen(urllib.request.Request(base + '/blobs/' + expected, headers=headers), timeout=120) as response, temp.open('wb') as out:
            shutil.copyfileobj(response, out)
        temp.rename(archive)
    if hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() != hash_value: raise RuntimeError('Layer digest mismatch')
    print(name, 'extracting', expected, flush=True)
    links = []
    with tarfile.open(archive, 'r:*') as tar:
        for entry in tar:
            member = posixpath.normpath(entry.name)
            if member == '..' or member.startswith('../') or member.startswith('/'): raise RuntimeError('Unsafe OCI member')
            if member == 'dev' or member.startswith('dev/'): continue
            if Path(member).name == '.wh..wh..opq':
                folder = rooted(posixpath.dirname(member))
                if folder.exists():
                    for child in folder.iterdir(): remove(child)
                continue
            if Path(member).name.startswith('.wh.'):
                remove(rooted(posixpath.join(posixpath.dirname(member), Path(member).name[4:]), False)); continue
            dest = rooted(member, False)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if entry.isdir():
                if dest.is_symlink(): continue
                dest.mkdir(exist_ok=True); dest.chmod((entry.mode & 0o777) | 0o700)
            elif entry.issym():
                remove(dest); dest.symlink_to(entry.linkname)
            elif entry.islnk(): links.append((member, entry.linkname))
            elif entry.isfile():
                remove(dest)
                with tar.extractfile(entry) as src, dest.open('wb') as out: shutil.copyfileobj(src, out)
                dest.chmod(entry.mode & 0o777)
    for member, target in links:
        dest = rooted(member, False); remove(dest); os.link(rooted(target), dest)
(root / '.cgl-rootfs-ready').write_text(json.dumps({'registry':registry, 'repository':repository, 'tag':tag, 'manifest':digest}, indent=2))
