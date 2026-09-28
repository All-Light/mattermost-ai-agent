#!/usr/bin/env python3
"""Read-only conversation overview. Bind only to loopback; access via SSH."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit


def escape(value):
    return html.escape(str(value or ""), quote=True)


def message_text(raw):
    try:
        content = json.loads(raw)
    except (ValueError, TypeError):
        return str(raw)
    if isinstance(content, str):
        return content
    if not isinstance(content, dict):
        return "[No readable text]"
    # Do not expose model reasoning, tool arguments/results, or provider metadata.
    texts = [part["text"] for part in content.get("parts", [])
             if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)]
    if texts:
        return "\n\n".join(texts)
    return content.get("content") if isinstance(content.get("content"), str) else "[Tool activity or attachment; no message text]"


def connect(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


STYLE = """
body{font:16px system-ui,sans-serif;background:#f6f7fa;color:#162032;max-width:1060px;margin:36px auto;padding:0 20px}
a{color:#155ac7}h1{margin-bottom:6px}p,small{color:#526078}.cards{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0}
.card,article{background:white;border:1px solid #dce2ec;border-radius:12px;padding:18px}.card strong{font-size:28px;display:block}
table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;text-align:left;border-bottom:1px solid #e2e6ed;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.5}article{margin:14px 0}.role{font-weight:700}nav{display:flex;gap:20px;margin:22px 0}code{overflow-wrap:anywhere}
"""


def render(db, params):
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    body = '<h1>UUAIS agent usage</h1><p>Private, read-only conversation history · <a href="/">Refresh</a></p>'
    body += '<nav><a href="/">Conversations</a><a href="/?view=reminders">CRM reminders</a></nav>'
    if "mastra_messages" not in tables:
        body += '<p>No conversation history has been stored yet.</p>'
    else:
        incoming = "(role='user' OR (role='signal' AND type='user'))"
        stats = db.execute(f"""SELECT count(*) AS records,
            sum(CASE WHEN {incoming} THEN 1 ELSE 0 END) AS incoming,
            sum(CASE WHEN role='assistant' THEN 1 ELSE 0 END) AS replies,
            sum(CASE WHEN {incoming} AND julianday(createdAt)>=julianday('now','-7 days') THEN 1 ELSE 0 END) AS week,
            count(DISTINCT thread_id) AS conversations FROM mastra_messages""").fetchone()
        body += '<div class="cards">' + ''.join(
            f'<div class="card"><strong>{int(stats[key] or 0)}</strong>{label}</div>'
            for key, label in [("incoming", "Incoming messages"), ("replies", "Assistant records"),
                               ("week", "Incoming · last 7 days"), ("conversations", "Conversations")]) + '</div>'
        body += '<p>Counts reflect retained Mastra history, not tokens or cost. Commands handled before the model are not recorded here. Times are shown as stored (normally UTC).</p>'
        thread = params.get("thread", [""])[0]
        page = max(0, min(int(params.get("page", ["0"])[0]), 100000))
        if params.get("view", [""])[0] == "reminders":
            body += '<h2>Recent CRM reminder deliveries</h2>'
            if "crm_reminder_posts" in tables:
                rows = db.execute("SELECT * FROM crm_reminder_posts ORDER BY created_at DESC,post_id DESC LIMIT 51 OFFSET ?", (page * 50,)).fetchall()
                for row in rows[:50]:
                    timestamp = datetime.fromtimestamp(row["created_at"] / 1000, timezone.utc).isoformat()
                    body += f'<article><div class="role">To {escape(row["user_id"])}</div><small>Task {escape(row["task_id"])} · {escape(timestamp)}</small><pre>{escape(row["message"])}</pre></article>'
                body += pages(page, len(rows) > 50, "view=reminders")
            else:
                body += '<p>No CRM reminder deliveries yet.</p>'
        elif thread:
            body += f'<h2>Conversation</h2><small>{escape(thread)}</small>'
            rows = db.execute("SELECT * FROM mastra_messages WHERE thread_id=? ORDER BY createdAt DESC,id DESC LIMIT 101 OFFSET ?", (thread, page * 100)).fetchall()
            body += '<p>Latest 100 messages, shown oldest first. Use Older for earlier messages.</p>'
            for row in reversed(rows[:100]):
                label = "Incoming" if row["role"] == "user" or (row["role"] == "signal" and row["type"] == "user") else row["role"].capitalize()
                body += f'<article><div class="role">{escape(label)}</div><small>{escape(row["createdAt"])}</small><pre>{escape(message_text(row["content"]))}</pre></article>'
            body += pages(page, len(rows) > 100, "thread=" + quote(thread, safe=""))
        else:
            title_join = 'LEFT JOIN mastra_threads t ON t.id=m.thread_id' if 'mastra_threads' in tables else ''
            title = 'max(t.title)' if title_join else 'NULL'
            rows = db.execute(f"""SELECT m.thread_id,{title} AS title,count(*) AS records,max(m.createdAt) AS latest
                FROM mastra_messages m {title_join} GROUP BY m.thread_id ORDER BY latest DESC,m.thread_id LIMIT 51 OFFSET ?""", (page * 50,)).fetchall()
            body += '<h2>Conversations</h2><table><tr><th>Conversation</th><th>Records</th><th>Latest</th></tr>'
            for row in rows[:50]:
                body += f'<tr><td><a href="/?thread={quote(row["thread_id"], safe="")}">{escape(row["title"] or row["thread_id"])}</a></td><td>{row["records"]}</td><td>{escape(row["latest"])}</td></tr>'
            body += '</table>' + pages(page, len(rows) > 50, '')
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UUAIS agent usage</title><style>' + STYLE + '</style><body>' + body + '</body></html>'


def pages(page, more, query):
    links = []
    if page:
        links.append(f'<a href="/?{query}&amp;page={page-1}">Newer</a>')
    if more:
        links.append(f'<a href="/?{query}&amp;page={page+1}">Older</a>')
    return '<nav>' + ''.join(links) + '</nav>'


def handler(database):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            # Reject DNS rebinding and cross-origin requests; no public listener or CORS.
            host = self.headers.get('Host', '').split(':')[0].lower()
            if host not in ('localhost', '127.0.0.1') or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self.send_error(403)
                return
            url = urlsplit(self.path)
            if url.path != '/':
                self.send_error(404)
                return
            try:
                with closing(connect(database)) as db:
                    page = render(db, parse_qs(url.query)).encode()
            except ValueError:
                self.send_error(400, 'Invalid page number')
                return
            except sqlite3.Error:
                self.send_error(503, 'Conversation database unavailable')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(page)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, *_):
            pass  # Conversation identifiers do not belong in HTTP access logs.
    return Handler


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', default='/var/lib/uuais-agent/mastra.db')
    parser.add_argument('--port', type=int, default=4112)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(args.database))
    print(f'UUAIS usage overview: http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
