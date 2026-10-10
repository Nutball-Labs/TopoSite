// auth.test.js — TopoSite accepts exactly the logins Z-Wave JS UI accepts (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { authenticate, verifyJWT, isTrustedRequest } from '../lib/auth.js'

const SECRET = 'a'.repeat(64)
const b64url = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url')

/** Sign like jsonwebtoken's default (HS256), as Z-Wave JS UI does. */
function sign(payload, secret = SECRET, header = { alg: 'HS256', typ: 'JWT' }) {
    const hp = `${b64url(header)}.${b64url(payload)}`
    return `${hp}.${createHmac('sha256', secret).update(hp).digest('base64url')}`
}

async function store({ authEnabled, users = [{ username: 'admin' }], secret = SECRET }) {
    const dir = await mkdtemp(path.join(tmpdir(), 'toposite-auth-'))
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ gateway: { authEnabled } }))
    await writeFile(path.join(dir, 'users.json'), JSON.stringify(users))
    if (secret) await writeFile(path.join(dir, '.session-secret'), secret)
    return dir
}

const now = () => Math.floor(Date.now() / 1000)
const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } })

test('verifyJWT accepts a valid HS256 token and rejects tampering, expiry and other algs', () => {
    const t = sign({ username: 'admin', exp: now() + 60 })
    assert.equal(verifyJWT(t, SECRET).username, 'admin')
    assert.throws(() => verifyJWT(t, 'b'.repeat(64)), /bad signature/)
    assert.throws(() => verifyJWT(sign({ username: 'admin', exp: now() - 1 }), SECRET), /expired/)
    const [h, , s] = t.split('.')
    assert.throws(() => verifyJWT(`${h}.${b64url({ username: 'root', exp: now() + 60 })}.${s}`, SECRET), /bad signature/)
    const none = `${b64url({ alg: 'none' })}.${b64url({ username: 'admin' })}.`
    assert.throws(() => verifyJWT(none, SECRET), /unsupported alg/)
    assert.throws(() => verifyJWT('nope', SECRET), /malformed/)
})

test('auth off in Z-Wave JS UI → open, like Z-Wave JS UI itself', async () => {
    const dir = await store({ authEnabled: false })
    assert.deepEqual(await authenticate({ headers: {} }, dir, {}), { ok: true })
})

test('auth on → valid token for an existing user required', async () => {
    const dir = await store({ authEnabled: true })
    assert.equal((await authenticate({ headers: {} }, dir, {})).ok, false)
    const ok = await authenticate(bearer(sign({ username: 'admin', exp: now() + 60 })), dir, {})
    assert.deepEqual(ok, { ok: true, user: 'admin' })
    const viaHeader = await authenticate({ headers: { 'x-access-token': sign({ username: 'admin', exp: now() + 60 }) } }, dir, {})
    assert.equal(viaHeader.ok, true)
    const gone = await authenticate(bearer(sign({ username: 'deleted', exp: now() + 60 })), dir, {})
    assert.deepEqual(gone, { ok: false, reason: 'user not found' })
    const forged = await authenticate(bearer(sign({ username: 'admin', exp: now() + 60 }, 'x'.repeat(64))), dir, {})
    assert.equal(forged.ok, false)
})

test('auth on → SESSION_SECRET env wins over the store file; missing secret fails closed', async () => {
    const dir = await store({ authEnabled: true, secret: null })
    const t = sign({ username: 'admin', exp: now() + 60 }, 'env-secret')
    assert.equal((await authenticate(bearer(t), dir, {})).ok, false, 'no secret file, no env → deny')
    assert.equal((await authenticate(bearer(t), dir, { SESSION_SECRET: 'env-secret' })).ok, true)
    const placeholder = { SESSION_SECRET: 'DEFAULT_SESSION_SECRET_CHANGE_ME' }
    assert.equal((await authenticate(bearer(sign({ username: 'admin' }, placeholder.SESSION_SECRET)), dir, placeholder)).ok, false)
})

test('no store dir → deny', async () => {
    assert.equal((await authenticate({ headers: {} }, null, {})).ok, false)
})

test("Z-Wave JS UI's trusted listener is recognized by port or unix path", async () => {
    const env = { TRUSTED_API_LISTEN: '172.30.32.0/23:8099' }
    assert.equal(isTrustedRequest({ socket: { localPort: 8099 } }, env), true)
    assert.equal(isTrustedRequest({ socket: { localPort: 8091 } }, env), false)
    assert.equal(isTrustedRequest({ socket: { localPort: 8099 } }, {}), false)
    const unix = { TRUSTED_API_LISTEN: '/run/zui.sock' }
    assert.equal(isTrustedRequest({ socket: { server: { address: () => '/run/zui.sock' } } }, unix), true)
    const dir = await store({ authEnabled: true })
    assert.equal((await authenticate({ headers: {}, socket: { localPort: 8099 } }, dir, env)).ok, true)
})

// SN: 00002
