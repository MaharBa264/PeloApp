import { D1 } from './d1.js';
import worker from '../src/worker.js';

export async function setup(extraEnv = {}) {
  const DB = new D1(), env = { DB, BOOTSTRAP_TOKEN: 'private-installation-token', APP_ENV: 'development', ...extraEnv };
  let cookie = '', ip = 1;
  async function raw(path, method = 'GET', data, opts = {}) {
    const headers = { Origin: 'https://pelo.test', 'Content-Type': 'application/json', Cookie: opts.cookie ?? cookie, 'CF-Connecting-IP': String(ip++), ...opts.headers };
    if (opts.noOrigin) delete headers.Origin;
    return worker.fetch(new Request(`https://pelo.test${path}`, { method, headers, body: data === undefined || data === null ? undefined : typeof data === 'string' ? data : JSON.stringify(data) }), env);
  }
  async function call(path, method = 'GET', data, opts = {}) {
    const response = await raw(`/api${path}`, method, data, opts);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const login = async (email, password = 'long-password-test') => { const r = await call('/login', 'POST', { email, password }); return r.cookie?.split(';')[0]; };
  await call('/setup', 'POST', { token: env.BOOTSTRAP_TOKEN, name: 'Admin', email: 'admin@test.com', password: 'long-password-test' });
  cookie = await login('admin@test.com');
  const key = () => ({ headers: { 'Idempotency-Key': crypto.randomUUID() } });
  const adminCookie = cookie;
  return { DB, env, raw, call, login, key, adminCookie, set: c => { cookie = c; } };
}
