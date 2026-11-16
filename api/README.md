# API REST — Clientes e Favoritos

Atividade prática em JavaScript com Hono, Cloudflare Workers, Cloudflare D1 e Wrangler. Os 11 endpoints ficam na raiz do Worker. O front-end Nuxt da pasta superior é independente e ainda não consome esta API.

## Entrega publicada

- Código público: https://github.com/MateusSaraiva684/avila-kids-api
- API: https://avila-kids-api.mateussaraiva684.workers.dev
- Verificação em 16/11/2026: 10 testes automatizados e teste HTTP dos 11 endpoints aprovados, tanto localmente quanto na publicação. O teste público usou o D1 remoto e a Fake Store API real e removeu seu cliente temporário ao terminar.

## Executar localmente

Requisitos: Node.js 24 e npm 11.

```bash
cd api
npm ci
npm run db:local
npm run dev
```

API em `http://localhost:8787`. O D1 local persiste em `.wrangler/state/`, ignorado pelo Git, e é separado do remoto. `wrangler.jsonc` contém o identificador do banco desta entrega, que não é uma credencial. Para publicar em outra conta, crie seu banco e substitua esse ID. Desenvolvimento local não exige login.

## Endpoints

Sucesso usa `{ "data": ... }`; erro usa `{ "error": { "message": "..." } }`. Exclusões retornam 204 sem corpo.

| Método | Rota | Corpo JSON | Sucesso |
| --- | --- | --- | --- |
| POST | `/clients` | `{"name":"Ana Silva","email":"ana@example.com","password":"senha-forte-123"}` | 201, cliente e Location |
| GET | `/clients` | — | 200, lista de clientes |
| GET | `/clients/:id` | — | 200, cliente |
| PUT | `/clients/:id` | `{"name":"Ana Souza","email":"ana@example.com"}` | 200, cliente atualizado |
| DELETE | `/clients/:id` | — | 204 |
| GET | `/products` | — | 200, produtos externos |
| GET | `/products/:id` | — | 200, produto externo |
| GET | `/categories` | — | 200, categorias externas |
| POST | `/clients/:id/favorites` | `{"product_id":1}` | 201, favorito |
| GET | `/clients/:id/favorites` | — | 200, relacionamentos |
| DELETE | `/clients/:id/favorites/:productId` | — | 204 |

Cliente retornado: `id`, `name`, `email`, `created_at`. Senha e hash nunca são retornados. Favorito: `id`, `client_id`, `product_id`, `created_at`. Consulte `/products/:id` para os detalhes de cada favorito; falhas externas não impedem consultar ou remover relacionamentos salvos.

PUT exige nome e e-mail; `password` é opcional e, quando omitido, mantém o hash anterior. IDs são inteiros positivos. Nome: 2–120 caracteres após trim. E-mail: formato válido, até 254 caracteres, normalizado para minúsculas e único. Senha: 8–128 caracteres, sem trim. JSON deve ser um objeto com somente os campos documentados e `Content-Type: application/json`. Limite do corpo: 16 KiB.

| Status | Significado |
| --- | --- |
| 400 | ID, JSON ou campos inválidos |
| 403 | Origem de preflight não autorizada |
| 404 | Cliente, produto, favorito ou rota inexistente |
| 409 | E-mail existente ou favorito duplicado |
| 413 | Corpo excede 16 KiB |
| 415 | Content-Type incompatível |
| 500 | Falha interna, sem detalhes privados |
| 502 | Falha de rede, timeout de 8 segundos ou resposta externa inválida |

Exemplo com curl, também importável no Postman:

```bash
curl -i http://localhost:8787/clients \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ana Silva","email":"ana@example.com","password":"senha-forte-123"}'
curl http://localhost:8787/products
curl -i http://localhost:8787/clients/1/favorites \
  -H 'Content-Type: application/json' -d '{"product_id":1}'
curl http://localhost:8787/clients/1/favorites
curl -i -X DELETE http://localhost:8787/clients/1/favorites/1
```

## Banco e senhas

`migrations/0001_initial.sql` cria `clients` e `favorites`. E-mail tem UNIQUE sem distinção de maiúsculas. Favoritos têm chave estrangeira com `ON DELETE CASCADE` e `UNIQUE(client_id, product_id)`, garantindo integridade também em requisições concorrentes. Consultas usam parâmetros. Produtos são obtidos externamente; somente seus IDs são salvos no D1.

Senhas usam PBKDF2-HMAC-SHA-256 via Web Crypto, salt aleatório de 16 bytes, 100.000 iterações e resultado de 32 bytes. Algoritmo, custo e salt acompanham o hash para permitir evolução. O custo respeita o limite do runtime Workers; não equivale à recomendação atual de 600.000 iterações para PBKDF2-SHA-256. Para uso comercial, revisar a estratégia de identidade e hash junto com autenticação, autorização por cliente e proteção contra abuso.

Esta é uma API acadêmica: clientes e favoritos não exigem autenticação, conforme o contrato da atividade. Use somente dados fictícios. CORS limita leitura por navegadores às origens de `CORS_ORIGINS`, mas não autentica nem restringe chamadas curl/Postman. O cadastro não cria uma sessão de login para a loja.

## Testar

```bash
npm test
npm run build
# Com npm run dev em outro terminal:
npm run test:http
# Na publicação, criando e apagando somente um cliente temporário:
API_ORIGIN=https://SEU-WORKER.workers.dev npm run test:http
```

Os testes executam a migração e as consultas reais no SQLite com adaptador para o contrato D1; a API externa é controlada para cobrir falhas. O teste HTTP usa o runtime e a Fake Store API reais, percorrendo os 11 endpoints. Persistência após reabertura, exclusão em cascata e isolamento de favoritos são verificados na suíte SQLite. O build é um dry-run de publicação.

## Publicar no Cloudflare

```bash
npx wrangler login
npx wrangler d1 create avila-kids-api
```

Copie o `database_id` retornado para o binding `DB` em `wrangler.jsonc`. Mantenha `database_name` igual ao nome criado. Configure `CORS_ORIGINS` com as origens reais do front-end, separadas por vírgula, sem barra final. Não coloque tokens neste arquivo.

```bash
npm run db:remote
npm run deploy
```

O Wrangler informa a URL pública `https://avila-kids-api.<subdominio>.workers.dev`. Execute o teste HTTP nessa URL para confirmar D1 e consumo externo. Não entregue o endereço local ou ilustrativo como uma publicação validada.

## GitHub e entrega

Publique o repositório em modo público, incluindo `api/`, lockfile e migração; não inclua `.env`, `.dev.vars`, `node_modules` ou `.wrangler`. No Teams, envie o link público do GitHub e a URL real do Worker após os testes. Não é necessário enviar código ou ZIP no Teams. O front-end opcional não faz parte desta implementação.

Referências: [D1 e Workers](https://developers.cloudflare.com/d1/get-started/), [migrações](https://developers.cloudflare.com/d1/reference/migrations/), [consultas parametrizadas](https://developers.cloudflare.com/d1/worker-api/prepared-statements/), [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Fake Store API](https://fakestoreapi.com/docs).
