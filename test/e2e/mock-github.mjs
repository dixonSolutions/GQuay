/**
 * A GitHub API stand-in for the end-to-end test.
 *
 * Answers only what the Router calls during a delivery: the installation
 * lookup, the token mint, the actor's permission level, Actions Variables, the
 * repo config file, and the issue/comments reads that build a spawn prompt.
 *
 * It exists so the whole webhook -> parked-call loop can be exercised without
 * a GitHub App, a public URL, or a network. Everything it returns is the
 * minimum shape the Router reads — if the Router starts reading a new field,
 * this will return undefined for it and the test will say so.
 */

import { createServer } from 'node:http';

export function startMockGitHub(port) {
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    res.setHeader('content-type', 'application/json');

    if (url.endsWith('/installation')) {
      res.end(JSON.stringify({ id: 1 }));
    } else if (url.endsWith('/access_tokens')) {
      res.end(
        JSON.stringify({
          token: 'ghs_mock',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
    } else if (url.includes('/collaborators/') && url.endsWith('/permission')) {
      // The write-access guard. Returning "read" here is how you test that
      // events from unprivileged actors are dropped.
      res.end(JSON.stringify({ permission: 'write' }));
    } else if (url.includes('/actions/variables')) {
      res.end(JSON.stringify({ variables: [] }));
    } else if (url.includes('/contents/')) {
      res.writeHead(404);
      res.end('{}');
    } else if (/\/issues\/\d+\/comments$/.test(url)) {
      res.end(req.method === 'GET' ? '[]' : JSON.stringify({ id: 1 }));
    } else if (/\/issues\/\d+$/.test(url)) {
      res.end(
        JSON.stringify({
          number: 42,
          title: 'Broken login',
          body: 'It fails on refresh',
          labels: [],
          user: { login: 'alice', type: 'User' },
        }),
      );
    } else {
      res.end(JSON.stringify({ default_branch: 'main' }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
