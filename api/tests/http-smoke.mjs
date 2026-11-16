import assert from 'node:assert/strict'

const origin = (process.env.API_ORIGIN || 'http://localhost:8787').replace(/\/$/, '')
const ids = []
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = response.status === 204 ? null : await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`)
  return payload?.data
}

try {
  const input = { name: 'Teste HTTP', email: `smoke-${crypto.randomUUID()}@example.com`, password: 'somente-teste-123' }
  const client = await request('/clients', 'POST', input, 201)
  ids.push(client.id)
  assert.equal(client.password_hash, undefined)
  const base = `/clients/${client.id}`
  assert.ok((await request('/clients')).some(item => item.id === client.id))
  assert.equal((await request(base)).email, input.email)
  await request(base, 'PUT', { name: 'Teste Atualizado', email: input.email })
  await request('/clients', 'POST', input, 409)
  const products = await request('/products')
  assert.ok(products.length > 0)
  const product = products[0]
  assert.equal((await request(`/products/${product.id}`)).id, product.id)
  assert.ok(Array.isArray(await request('/categories')))
  await request(`${base}/favorites`, 'POST', { product_id: product.id }, 201)
  await request(`${base}/favorites`, 'POST', { product_id: product.id }, 409)
  assert.equal((await request(`${base}/favorites`))[0].product_id, product.id)
  await request(`${base}/favorites/${product.id}`, 'DELETE', undefined, 204)
  assert.deepEqual(await request(`${base}/favorites`), [])
  await request(base, 'DELETE', undefined, 204)
  ids.pop()
  await request(base, 'GET', undefined, 404)
  console.log('OK: os 11 endpoints passaram no teste HTTP, incluindo a Fake Store API e favoritos duplicados.')
}
finally {
  for (const id of ids) await fetch(`${origin}/clients/${id}`, { method: 'DELETE' })
}
