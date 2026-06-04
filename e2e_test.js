const base = 'http://127.0.0.1:3000';

async function prettyLog(res, path) {
  console.log(`\n${res.status} ${path}`);
  for (const [k, v] of res.headers) console.log(`${k}: ${v}`);
  const text = await res.text();
  console.log(text.length > 1000 ? text.slice(0, 1000) + '... (truncated)' : text);
}

(async () => {
  try {
    const f = globalThis.fetch || (await import('node-fetch')).default;
    let res = await f(`${base}/health`);
    await prettyLog(res, '/health');

    res = await f(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@hisabpro.com', password: 'Demo@1234' }),
    });
    await prettyLog(res, '/api/v1/auth/login');

    const setCookie = res.headers.get('set-cookie');
    console.log('set-cookie header:', setCookie);
    const cookie = setCookie ? setCookie.split(';')[0] : null;

    res = await f(`${base}/api/v1/auth/me`, { headers: cookie ? { Cookie: cookie } : {} });
    await prettyLog(res, '/api/v1/auth/me');

    res = await f(`${base}/api/v1/dashboard`, { headers: cookie ? { Cookie: cookie } : {} });
    await prettyLog(res, '/api/v1/dashboard');
  } catch (err) {
    console.error('E2E test error:', err);
    process.exitCode = 1;
  }
})();
