#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Render a private Caddy include from the same secret mounted in the app."""
import argparse,os,pathlib,tempfile
p=argparse.ArgumentParser();p.add_argument('--proof-file',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args()
proof=a.proof_file.read_text().strip()
if len(proof)!=64 or any(c not in '0123456789abcdefABCDEF' for c in proof):raise SystemExit('Invalid proxy proof format')
a.output.parent.mkdir(parents=True,exist_ok=True)
fd,name=tempfile.mkstemp(dir=a.output.parent,prefix='.yeastcraft-proof-');os.fchmod(fd,0o600)
try:
 with os.fdopen(fd,'w') as f:f.write('(yeastcraft_proxy_auth) {\n header_up X-YeastCraft-Proxy-Proof "'+proof+'"\n}\n')
 os.replace(name,a.output)
finally:
 if os.path.exists(name):os.unlink(name)
print('Private Caddy include generated; proof not displayed')
