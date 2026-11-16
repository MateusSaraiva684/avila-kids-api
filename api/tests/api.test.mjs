import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/index.js'

// Executes the production migration and SQL on SQLite, with the D1 statement interface.
function d1(sqlite) {
  return { prepare(sql) {
    const statement = sqlite.prepare(sql)
    let params = []
    return {
      bind(...values) { params = values; return this },
      async first() { return statement.get(...params) || null },
      async all() { return { results: statement.all(...params) } },
    }
  } }
}
const product = { id: 1, title: 'Produto de teste', price: 10 }
const customer = { name: 'Ana Silva', email: 'ana@example.com', password: 'senha-forte-123' }
let sqlite, env, app
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
  env = { DB: d1(sqlite), CORS_ORIGINS: 'http://localhost:3000' }
  app = createApp(async (url) => {
    const path = new URL(url).pathname
    return Response.json(path === '/products' ? [product] : path === '/products/categories' ? ['electronics'] : path === '/products/1' ? product : null)
  })
})
afterEach(() => sqlite.close())
const request = (path, method = 'GET', body, headers = {}) => app.request(path, {
  method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
}, env)
async function create(overrides = {}) {
  const response = await request('/clients', 'POST', { ...customer, ...overrides })
  assert.equal(response.status, 201)
  const { data } = await response.json()
  assert.equal(response.headers.get('location'), `/clients/${data.id}`)
  assert.equal(data.password_hash, undefined)
  return data
}

test('client CRUD never exposes passwords; updates preserve or replace salted hash', async () => {
  const client = await create({ email: ' ANA@EXAMPLE.COM ' })
  assert.equal(client.email, 'ana@example.com')
  const hash = sqlite.prepare('SELECT password_hash FROM clients').get().password_hash
  assert.match(hash, /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/)
  assert.equal((await request('/clients')).status, 200)
  assert.equal((await (await request(`/clients/${client.id}`)).json()).data.name, customer.name)
  let response = await request(`/clients/${client.id}`, 'PUT', { name: 'Ana Souza', email: client.email })
  assert.equal(response.status, 200)
  assert.equal(sqlite.prepare('SELECT password_hash FROM clients').get().password_hash, hash)
  response = await request(`/clients/${client.id}`, 'PUT', { ...customer, password: 'outra-senha-123' })
  assert.equal(response.status, 200)
  assert.notEqual(sqlite.prepare('SELECT password_hash FROM clients').get().password_hash, hash)
  assert.equal((await request(`/clients/${client.id}`, 'DELETE')).status, 204)
  assert.equal((await request(`/clients/${client.id}`)).status, 404)
  assert.equal((await request(`/clients/${client.id}`, 'DELETE')).status, 404)
})

test('email uniqueness is enforced on creation and update', async () => {
  await create()
  assert.equal((await request('/clients', 'POST', { ...customer, email: 'ANA@example.com' })).status, 409)
  const second = await create({ email: 'other@example.com' })
  assert.equal((await request(`/clients/${second.id}`, 'PUT', customer)).status, 409)
})

test('validation rejects malformed input, IDs and oversized bodies', async () => {
  for (const body of [null, [], {}, { ...customer, name: ' ' }, { ...customer, email: 'invalid' }, { ...customer, password: 'short' }, { ...customer, role: 'admin' }]) {
    assert.equal((await request('/clients', 'POST', body)).status, 400)
  }
  for (const id of ['0', '-1', '1.2', '1e2', '9007199254740992', 'abc']) {
    assert.equal((await request(`/clients/${id}`)).status, 400)
  }
  assert.equal((await request('/clients/999')).status, 404)
  assert.equal((await request('/clients', 'POST')).status, 415)
  assert.equal((await app.request('/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, env)).status, 400)
  assert.equal((await request('/clients', 'POST', { ...customer, name: 'a'.repeat(17000) })).status, 413)
})

test('products and categories are proxied; missing external product returns 404', async () => {
  assert.deepEqual((await (await request('/products')).json()).data, [product])
  assert.deepEqual((await (await request('/products/1')).json()).data, product)
  assert.deepEqual((await (await request('/categories')).json()).data, ['electronics'])
  assert.equal((await request('/products/999')).status, 404)
})

test('favorites are isolated, unique, removable and cascade on client deletion', async () => {
  const first = await create()
  const second = await create({ email: 'second@example.com' })
  const path = `/clients/${first.id}/favorites`
  assert.equal((await request(path, 'POST', { product_id: 1 })).status, 201)
  assert.equal((await request(path, 'POST', { product_id: 1 })).status, 409)
  assert.equal((await request(`/clients/${second.id}/favorites`, 'POST', { product_id: 1 })).status, 201)
  assert.equal((await request(`/clients/${second.id}/favorites/2`, 'DELETE')).status, 404)
  assert.equal((await (await request(path)).json()).data.length, 1)
  assert.equal((await request(`${path}/1`, 'DELETE')).status, 204)
  assert.equal((await (await request(path)).json()).data.length, 0)
  assert.equal((await (await request(`/clients/${second.id}/favorites`)).json()).data.length, 1)
  await request(`/clients/${second.id}`, 'DELETE')
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM favorites').get().count, 0)
})

test('favorites reject invalid products, payloads and nonexistent clients', async () => {
  const client = await create()
  const path = `/clients/${client.id}/favorites`
  for (const body of [{}, { product_id: '1' }, { product_id: 0 }, { product_id: 1.1 }, { product_id: 1, extra: true }]) {
    assert.equal((await request(path, 'POST', body)).status, 400)
  }
  assert.equal((await request(path, 'POST', { product_id: 999 })).status, 404)
  assert.equal((await request('/clients/999/favorites', 'POST', { product_id: 1 })).status, 404)
  assert.equal((await request('/clients/999/favorites')).status, 404)
})

test('external network, HTTP, invalid JSON and shape failures return 502', async () => {
  for (const fetcher of [
    async () => { throw new Error('network') },
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('<html>blocked</html>'),
    async () => Response.json({ unexpected: true }),
  ]) {
    app = createApp(fetcher)
    assert.equal((await request('/products')).status, 502)
  }
})

test('CORS preflight permits only configured origins', async () => {
  const response = await request('/clients', 'OPTIONS', undefined, { Origin: 'http://localhost:3000' })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000')
  assert.equal((await request('/clients', 'OPTIONS', undefined, { Origin: 'https://unknown.example' })).status, 403)
  assert.equal((await request('/clients')).headers.get('cache-control'), 'no-store')
  assert.equal((await request('/unknown')).status, 404)
})

test('unexpected database errors do not disclose internal SQL', async () => {
  env.DB = { prepare() { throw new Error('private database details') } }
  const response = await request('/clients')
  assert.equal(response.status, 500)
  assert.equal((await response.json()).error.message, 'Erro interno do servidor.')
})

test('data persists after closing and reopening SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'avila-api-'))
  const path = join(directory, 'db.sqlite')
  try {
    const disk = new DatabaseSync(path)
    disk.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
    env.DB = d1(disk)
    await create()
    disk.close()
    const reopened = new DatabaseSync(path)
    env.DB = d1(reopened)
    assert.equal((await (await request('/clients')).json()).data[0].email, customer.email)
    reopened.close()
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
