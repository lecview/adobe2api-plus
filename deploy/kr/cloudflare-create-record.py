#!/usr/bin/env python3
"""Create only adobe2api.aimasker.com when absent; never overwrite a conflict."""

import configparser
import json
import pathlib
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://api.cloudflare.com/client/v4"
ZONE = "aimasker.com"
NAME = "adobe2api.aimasker.com"
CREDENTIALS = pathlib.Path("/etc/letsencrypt/cloudflare.ini")
BACKUP_DIR = pathlib.Path("/opt/adobe2api-plus/backups")


def token() -> str:
    parser = configparser.ConfigParser()
    parser.read_string("[cloudflare]\n" + CREDENTIALS.read_text(encoding="utf-8"))
    return parser["cloudflare"]["dns_cloudflare_api_token"].strip()


def call(method: str, path: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.load(response)
    if not body.get("success"):
        raise RuntimeError(body.get("errors"))
    return body["result"]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: cloudflare-create-record.py <kr-public-ipv4>")
    target = sys.argv[1]
    zones = call("GET", "/zones?" + urllib.parse.urlencode({"name": ZONE, "status": "active"}))
    if len(zones) != 1:
        raise RuntimeError(f"expected one active zone, got {len(zones)}")
    zone_id = zones[0]["id"]
    records = call("GET", f"/zones/{zone_id}/dns_records?" + urllib.parse.urlencode({"name": NAME}))

    BACKUP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_DIR / f"{NAME}-before-create-{stamp}.json"
    backup.write_text(json.dumps({"name": NAME, "records": records}, indent=2) + "\n", encoding="utf-8")
    backup.chmod(0o600)

    if records:
        if len(records) == 1 and records[0].get("type") == "A" and records[0].get("content") == target and records[0].get("proxied") is False:
            print(json.dumps({"changed": False, "name": NAME, "type": "A", "content": target, "proxied": False, "backup": str(backup)}))
            return
        raise RuntimeError("refusing to overwrite an existing or conflicting DNS record")

    created = call("POST", f"/zones/{zone_id}/dns_records", {
        "type": "A",
        "name": NAME,
        "content": target,
        "ttl": 300,
        "proxied": False,
        "comment": "Independent adobe2api-plus service on KR host",
    })
    print(json.dumps({
        "changed": True,
        "id": created["id"],
        "name": created["name"],
        "type": created["type"],
        "content": created["content"],
        "ttl": created["ttl"],
        "proxied": created.get("proxied", False),
        "backup": str(backup),
    }))


if __name__ == "__main__":
    main()
