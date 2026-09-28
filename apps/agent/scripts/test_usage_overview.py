import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from usage_overview import connect, message_text, render


class OverviewTest(unittest.TestCase):
    def test_history_counts_and_text_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.db'
            db = sqlite3.connect(path)
            db.executescript('''CREATE TABLE mastra_messages(id TEXT, thread_id TEXT, content TEXT, role TEXT, type TEXT, createdAt TEXT);
                CREATE TABLE mastra_threads(id TEXT,title TEXT);
                INSERT INTO mastra_threads VALUES('thread','<script>title</script>');''')
            content = json.dumps({'parts': [{'type': 'text', 'text': '<img src=x>hello'}, {'type': 'reasoning', 'reasoning': 'private reasoning'}]})
            db.execute("INSERT INTO mastra_messages VALUES('1','thread',?,'signal','user',datetime('now'))", (content,))
            db.commit()
            db.close()
            with connect(path) as reader:
                overview = render(reader, {})
                self.assertIn('&lt;script&gt;title&lt;/script&gt;', overview)
                self.assertIn('<strong>1</strong>Incoming messages', overview)
                conversation = render(reader, {'thread': ['thread']})
                self.assertIn('&lt;img src=x&gt;hello', conversation)
                self.assertNotIn('private reasoning', conversation)
                self.assertNotIn('<img src=x>', conversation)
                with self.assertRaises(sqlite3.OperationalError):
                    reader.execute('DELETE FROM mastra_messages')
                self.assertNotIn('hello', render(reader, {'thread': ["' OR 1=1--"]}))

    def test_plain_legacy_and_tool_only_content(self):
        self.assertEqual(message_text('plain text'), 'plain text')
        self.assertEqual(message_text(json.dumps({'content': 'legacy'})), 'legacy')
        self.assertNotIn('secret', message_text(json.dumps({'parts': [{'type': 'tool-invocation', 'secret': 'secret'}]})))


if __name__ == '__main__':
    unittest.main()
