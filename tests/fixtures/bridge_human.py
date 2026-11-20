import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization

from xnbridge.app import build

home, cmd = Path(sys.argv[1]), sys.argv[2]
bridge = build(home)
pw = b"fixture-passphrase-only-for-tests"
if cmd == "init":
    bridge.approvals.generate_keypair(pw)
elif cmd == "grant":
    key = serialization.load_pem_private_key(bridge.settings.approver_key.read_bytes(), password=pw)
    print(bridge.approvals.grant(sys.argv[3], key)["state"])
