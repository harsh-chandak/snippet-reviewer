import type { Language } from '@/lib/types';

// One realistic, buggy snippet per language that has static rules, so a first-time user can
// see both rule and AI findings without hunting for code to paste.
export interface CodeExample {
  language: Language;
  label: string;
  title: string;
  code: string;
}

export const CODE_EXAMPLES: readonly CodeExample[] = [
  {
    language: 'javascript',
    label: 'JavaScript',
    title: 'Express route: user search and export',
    code: `const express = require('express');
const { exec } = require('child_process');
const db = require('./db');

const router = express.Router();

router.get('/users/search', async (req, res) => {
  const name = req.query.name;
  try {
    const rows = await db.query("SELECT * FROM users WHERE name = '" + name + "'");
    if (rows.length == 0) {
      return res.status(404).send('No users');
    }
    res.json(rows);
  } catch (err) {}
});

router.post('/users/export', (req, res) => {
  exec('tar -czf /tmp/export.tgz ' + req.body.folder, (err) => {
    if (err) return res.status(500).send(err.stack);
    res.download('/tmp/export.tgz');
  });
});

module.exports = router;
`,
  },
  {
    language: 'typescript',
    label: 'TypeScript',
    title: 'React comments widget',
    code: `import { useEffect, useState } from 'react';

interface Comment {
  id: number;
  author: string;
  html: string;
  link?: string;
}

export function Comments({ postId }: { postId: number }) {
  const [comments, setComments] = useState<Comment[]>([]);

  useEffect(() => {
    fetch('/api/posts/' + postId + '/comments')
      .then((res) => res.json())
      .then((data) => setComments(data));
  });

  return (
    <ul>
      {comments.map((c) => (
        <li>
          <strong>{c.author}</strong>
          <div dangerouslySetInnerHTML={{ __html: c.html }} />
          {c.link && (
            <a href={c.link} target="_blank">
              source
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
`,
  },
  {
    language: 'python',
    label: 'Python',
    title: 'Order report script',
    code: `import sqlite3
import subprocess


def load_orders(conn, customer, statuses=[]):
    statuses.append("paid")
    query = "SELECT id, total FROM orders WHERE customer = '%s'" % customer
    cur = conn.cursor()
    cur.execute(query)
    return [row for row in cur.fetchall() if row[1] != None]


def archive(path):
    subprocess.run("gzip " + path, shell=True)


def main():
    conn = sqlite3.connect("shop.db")
    try:
        orders = load_orders(conn, input("Customer: "))
        total = sum(o[1] for o in orders)
        print("Total:", total / len(orders))
        archive("report.txt")
    except:
        print("something went wrong")


if __name__ == "__main__":
    main()
`,
  },
  {
    language: 'sql',
    label: 'SQL',
    title: 'Monthly cleanup and inactive users',
    code: `-- Find customers with no orders this month and close their carts.
SELECT *
FROM customers c, orders o
WHERE c.email LIKE '%@example.com'
  AND c.deleted_at = NULL
  AND c.id NOT IN (SELECT customer_id FROM orders WHERE created_at > now() - interval '30 days');

UPDATE carts SET status = 'closed';

DELETE FROM sessions;
`,
  },
];
