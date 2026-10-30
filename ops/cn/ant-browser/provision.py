#!/usr/bin/env python3
"""Prepare the approved single-instance trial after verified artifact extraction.

Run as root on the target, then install the adjacent systemd unit. No Qingjian
stores are read or rewritten. Credentials are generated privately and never
printed. A subsequent invocation preserves the existing key and configuration.
"""
import os, pathlib, pwd, secrets, subprocess

assert os.geteuid() == 0
user = 'qingjian-ant-browser'
try:
    account = pwd.getpwnam(user)
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--home-dir', '/data/ant-browser', '--shell', '/usr/sbin/nologin', user], check=True)
    account = pwd.getpwnam(user)
root = pathlib.Path('/opt/ant-browser/releases/1.8.0')
assert (root / 'ant-chrome').is_file()
data = pathlib.Path('/data/ant-browser')
config = pathlib.Path('/etc/ant-browser')
for directory in (data, config):
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    os.chown(directory, account.pw_uid, account.pw_gid)
source = root / 'data'
if not source.is_symlink():
    assert source.is_dir() and not any(source.iterdir()), 'Existing Ant state requires operator inspection'
    source.rmdir()
    source.symlink_to(data, target_is_directory=True)
keyfile = config / 'api-key'
if not keyfile.exists():
    keyfile.write_text(secrets.token_hex(32) + '\n')
    keyfile.chmod(0o600)
    os.chown(keyfile, account.pw_uid, account.pw_gid)
key = keyfile.read_text().strip()
target = config / 'config.yaml'
if not target.exists():
    target.write_text('''database:
  type: sqlite
  sqlite:
    path: data/app.db
runtime:
  max_memory_mb: 128
  gc_percent: 75
logging:
  level: warn
  file_enabled: false
  interceptor:
    enabled: false
browser:
  user_data_root: data
  default_fingerprint_args:
    - --fingerprint-brand=Chrome
    - --fingerprint-platform=linux
    - --disable-non-proxied-udp
    - --fingerprinting-canvas-image-data-noise
    - --fingerprinting-client-rects-noise
  default_launch_args:
    - --disable-sync
    - --no-first-run
    - --headless=new
    - --disable-dev-shm-usage
    - --window-size=1280,900
  default_start_urls: []
  light_start_enabled: true
  restore_last_session: false
  default_connector_type: xray
launch_server:
  port: 19876
  auth:
    enabled: true
    api_key: ''' + key + '''
    header: X-Ant-Api-Key
automation:
  enabled: false
''')
    target.chmod(0o600)
    os.chown(target, account.pw_uid, account.pw_gid)
local_config = root / 'config.yaml'
if not local_config.is_symlink():
    local_config.rename(root / 'config.upstream.yaml')
    local_config.symlink_to(target)
current = pathlib.Path('/opt/ant-browser/current')
assert not current.exists() or current.resolve() == root
if not current.is_symlink():
    current.symlink_to(root, target_is_directory=True)
subprocess.run(['chown', '-hR', user + ':' + user, str(root)], check=True)
# Upstream atomically replaces config.yaml beside its executable. Keep this
# writable directory private even if upstream's replacement uses mode 0644.
root.chmod(0o700)
print('Ant user, private config and persistent state prepared; key not displayed.')
