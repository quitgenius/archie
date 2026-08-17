#!/usr/bin/env python3
"""Upload extracted knowledge files to the knowledgebase API."""

import argparse
import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def upload_batch(api_url, bank_id, items):
    payload = json.dumps({"bank_id": bank_id, "items": items, "async": True}).encode()
    req = Request(
        f"{api_url}/api/memories/retain",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req) as resp:
        return json.loads(resp.read())


def build_items(dir_path, manifest, source):
    items = []
    skipped = []

    for entry in manifest:
        txt_path = dir_path / entry["output_file"]
        if not txt_path.exists():
            skipped.append((entry["output_file"], "missing"))
            continue

        content = txt_path.read_text().strip()
        if not content:
            skipped.append((entry["output_file"], "empty"))
            continue

        doc_id = entry["output_file"].removesuffix(".txt")
        item = {
            "content": content,
            "document_id": doc_id,
            "observation_scopes": "combined",
            "metadata": {
                "source": source,
                "source_path": entry["source_path"],
                "file_type": entry["file_type"],
            },
        }
        if entry.get("date"):
            item["timestamp"] = entry["date"] + "T00:00:00"

        items.append(item)

    return items, skipped


def main():
    ap = argparse.ArgumentParser(description="Upload extracted knowledge to the API.")
    ap.add_argument("dir", help="Output dir from knowledge-extract (with metadata.json)")
    ap.add_argument("--api-url", default="http://localhost:19999")
    ap.add_argument("--bank-id", required=True)
    ap.add_argument("--source", default="GDrive Base Knowledge")
    ap.add_argument("--batch-size", type=int, default=10)
    ap.add_argument("--limit", type=int, default=None, help="Upload only the first N items")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    dir_path = Path(args.dir).resolve()
    manifest_path = dir_path / "metadata.json"
    if not manifest_path.exists():
        sys.exit(f"No metadata.json in {dir_path}")

    manifest = json.loads(manifest_path.read_text())
    items, skipped = build_items(dir_path, manifest, args.source)
    if args.limit:
        items = items[: args.limit]

    for name, reason in skipped:
        print(f"  SKIP ({reason}): {name}", file=sys.stderr)

    if not items:
        sys.exit("Nothing to upload")

    if args.dry_run:
        print(f"{len(items)} items to upload, {len(skipped)} skipped\n")
        for item in items:
            ts = item.get("timestamp", "no date")
            print(f"  {item['document_id']}  [{ts}]")
        return

    ok = fail = 0
    for i in range(0, len(items), args.batch_size):
        batch = items[i : i + args.batch_size]
        try:
            upload_batch(args.api_url, args.bank_id, batch)
            ok += len(batch)
            print(f"  Uploaded {ok}/{len(items)}")
        except (URLError, HTTPError) as e:
            fail += len(batch)
            print(f"  FAIL batch {i // args.batch_size + 1}: {e}", file=sys.stderr)

    print(f"\nDone: {ok} uploaded, {fail} failed, {len(skipped)} skipped")


if __name__ == "__main__":
    main()
