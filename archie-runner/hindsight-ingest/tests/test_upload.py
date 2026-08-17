from __future__ import annotations

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

import pytest

from upload import build_items

SCRIPT = str(Path(__file__).resolve().parent.parent / "upload.py")


# ── helpers ──────────────────────────────────────────────────────

def make_extract_dir(tmp_path, entries):
    """Create a fake extraction output directory with text files + metadata.json."""
    manifest = []
    for e in entries:
        slug = e["slug"]
        (tmp_path / slug).write_text(e.get("content", ""))
        manifest.append({
            "source_path": e.get("source_path", f"src/{slug}"),
            "output_file": slug,
            "file_type": e.get("file_type", "pptx"),
            "date": e.get("date"),
            "date_precision": e.get("date_precision"),
        })
    (tmp_path / "metadata.json").write_text(json.dumps(manifest))
    return tmp_path


# ── build_items ──────────────────────────────────────────────────

class TestBuildItems:
    def test_basic(self, tmp_path):
        d = make_extract_dir(tmp_path, [
            {"slug": "deck.txt", "content": "slide content", "date": "2025-10-28", "date_precision": "day"},
        ])
        items, skipped = build_items(d, json.loads((d / "metadata.json").read_text()), "GDrive")

        assert len(items) == 1
        assert skipped == []
        item = items[0]
        assert item["content"] == "slide content"
        assert item["document_id"] == "deck"
        assert item["timestamp"] == "2025-10-28T00:00:00"
        assert item["observation_scopes"] == "combined"
        assert item["metadata"]["source"] == "GDrive"

    def test_no_date_omits_timestamp(self, tmp_path):
        d = make_extract_dir(tmp_path, [
            {"slug": "handbook.txt", "content": "policies", "date": None, "date_precision": None},
        ])
        items, _ = build_items(d, json.loads((d / "metadata.json").read_text()), "GDrive")

        assert "timestamp" not in items[0]

    def test_skips_empty_files(self, tmp_path):
        d = make_extract_dir(tmp_path, [
            {"slug": "empty.txt", "content": "", "date": "2025-01-01"},
            {"slug": "whitespace.txt", "content": "   \n\n  ", "date": "2025-01-01"},
        ])
        items, skipped = build_items(d, json.loads((d / "metadata.json").read_text()), "GDrive")

        assert len(items) == 0
        assert len(skipped) == 2
        assert all(reason == "empty" for _, reason in skipped)

    def test_skips_missing_files(self, tmp_path):
        (tmp_path / "metadata.json").write_text(json.dumps([{
            "source_path": "gone.pptx",
            "output_file": "gone.txt",
            "file_type": "pptx",
            "date": None,
            "date_precision": None,
        }]))
        items, skipped = build_items(tmp_path, json.loads((tmp_path / "metadata.json").read_text()), "GDrive")

        assert len(items) == 0
        assert skipped == [("gone.txt", "missing")]

    def test_preserves_source_path_and_file_type(self, tmp_path):
        d = make_extract_dir(tmp_path, [
            {
                "slug": "memo.txt",
                "content": "strategy",
                "source_path": "2026 Strategy/Memo March 2026.pdf",
                "file_type": "pdf",
                "date": "2026-03-01",
                "date_precision": "month",
            },
        ])
        items, _ = build_items(d, json.loads((d / "metadata.json").read_text()), "GDrive Base Knowledge")

        meta = items[0]["metadata"]
        assert meta["source"] == "GDrive Base Knowledge"
        assert meta["source_path"] == "2026 Strategy/Memo March 2026.pdf"
        assert meta["file_type"] == "pdf"


# ── dry run e2e ──────────────────────────────────────────────────

class TestDryRun:
    def test_lists_items(self, tmp_path):
        d = make_extract_dir(tmp_path, [
            {"slug": "a.txt", "content": "hello", "date": "2025-01-01", "date_precision": "year"},
            {"slug": "b.txt", "content": "world", "date": None, "date_precision": None},
        ])
        result = subprocess.run(
            [sys.executable, SCRIPT, str(d), "--bank-id", "test-org", "--dry-run"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "2 items to upload" in result.stdout
        assert "2025-01-01T00:00:00" in result.stdout
        assert "no date" in result.stdout

    def test_nothing_to_upload(self, tmp_path):
        d = make_extract_dir(tmp_path, [
            {"slug": "empty.txt", "content": ""},
        ])
        result = subprocess.run(
            [sys.executable, SCRIPT, str(d), "--bank-id", "test-org", "--dry-run"],
            capture_output=True, text=True,
        )
        assert result.returncode != 0
        assert "Nothing to upload" in result.stderr


# ── upload e2e (mock server) ─────────────────────────────────────

class TestUploadE2E:
    def test_posts_to_api(self, tmp_path):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received.append(json.loads(self.rfile.read(length)))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')

            def log_message(self, *a):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()

        try:
            d = make_extract_dir(tmp_path, [
                {"slug": "doc.txt", "content": "real content", "date": "2025-06-01", "date_precision": "month"},
            ])
            result = subprocess.run(
                [
                    sys.executable, SCRIPT, str(d),
                    "--bank-id", "default-org",
                    "--api-url", f"http://127.0.0.1:{port}",
                    "--batch-size", "5",
                ],
                capture_output=True, text=True,
            )
            assert result.returncode == 0
            assert "Uploaded 1/1" in result.stdout

            assert len(received) == 1
            payload = received[0]
            assert payload["bank_id"] == "default-org"
            assert payload["async"] is True
            assert len(payload["items"]) == 1
            item = payload["items"][0]
            assert item["content"] == "real content"
            assert item["document_id"] == "doc"
            assert item["timestamp"] == "2025-06-01T00:00:00"
            assert item["metadata"]["source"] == "GDrive Base Knowledge"
        finally:
            server.shutdown()

    def test_batching(self, tmp_path):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received.append(json.loads(self.rfile.read(length)))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')

            def log_message(self, *a):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()

        try:
            d = make_extract_dir(tmp_path, [
                {"slug": f"doc{i}.txt", "content": f"content {i}", "date": None, "date_precision": None}
                for i in range(5)
            ])
            subprocess.run(
                [
                    sys.executable, SCRIPT, str(d),
                    "--bank-id", "test-org",
                    "--api-url", f"http://127.0.0.1:{port}",
                    "--batch-size", "2",
                ],
                capture_output=True, text=True, check=True,
            )
            assert len(received) == 3  # 2 + 2 + 1
            assert len(received[0]["items"]) == 2
            assert len(received[1]["items"]) == 2
            assert len(received[2]["items"]) == 1
        finally:
            server.shutdown()
