#!/usr/bin/python3
"""Host-owned Defold worker; no network or mounts of application secrets."""
import os, pathlib, re, resource, sys

engines = pathlib.Path('/opt/qingjian-cn/engines')
java = str(engines / 'java25/bin/java')
bob = str(engines / 'defold/1.14.0/bob.jar')
args = sys.argv[1:]
source = pathlib.Path.cwd().resolve()
root = source.parent
assert args and args.pop(0) == java
assert source.name == 'source' and re.fullmatch(r'[0-9a-f]{64}', root.name)
assert str(root).startswith(('/data/qingjian/', '/tmp/'))
assert args[args.index('-jar') + 1] == bob
assert args[args.index('--root') + 1] == str(source)
assert args[args.index('--bundle-output') + 1] == str(root / 'web')
os.umask(0o077)
resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
resource.setrlimit(resource.RLIMIT_CPU, (150, 150))
resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))
command = ['/usr/bin/bwrap', '--die-with-parent', '--unshare-all', '--new-session',
           '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
           '--ro-bind', '/lib64', '/lib64', '--ro-bind', str(engines), str(engines),
           '--tmpfs', '/tmp', '--bind', str(root), str(root), '--proc', '/proc',
           '--dev', '/dev', '--chdir', str(source), java, '-XX:+UseSerialGC',
           '-XX:CompressedClassSpaceSize=64m', '-XX:ReservedCodeCacheSize=64m',
           '-Xss512k', *args]
os.execve(command[0], command, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                            'HOME': str(source / '.home'), 'TMPDIR': str(source / '.tmp')})
