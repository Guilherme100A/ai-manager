# E2E local: CRM × ai-manager (chips falsos)

Roteiro para subir **tudo localmente** (ai-manager api + worker fake com `CRM_BRIDGE=on` + dashboard; CRM api +
worker em modo extensão + web em `/crm/`) e percorrer o cenário da integração. Nada de produção: `WA_TRANSPORT=fake`
sempre, banco e Redis exclusivos do teste.

Pré-requisitos: Postgres local em `127.0.0.1:5432` (usuário `wsm/wsm`), `redis-server` disponível, Node 22+, pnpm,
checkouts `ai-manager-crm` (branch `crm-integracao`) e `crm-copy` (branch `integracao-ai-manager`) lado a lado, com
`pnpm install` feito nos dois. Comandos em bash (Git Bash no Windows).

## 0. Variáveis

```bash
AIM=/c/Users/green/Downloads/wsp-aimanager/ai-manager-crm
CRM=/c/Users/green/Downloads/wsp-aimanager/crm-copy
E2E=$HOME/crm-e2e            # pasta de trabalho (logs, envs, storage); qualquer lugar fora dos repos
mkdir -p $E2E/logs $E2E/redis-data $E2E/crm-storage
r() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }

cat > $E2E/common.env <<EOF
DATABASE_URL=postgres://wsm:wsm@127.0.0.1:5432/wsm_crm_e2e
REDIS_URL=redis://127.0.0.1:6390/0
INTERNAL_TOKEN=e2e-internal-$(r 12 hex)
CRM_SSO_SECRET=$(r 32 base64url)
WA_EVENTS_STREAM=wsm:events
LOG_LEVEL=info
EOF
cat > $E2E/aim.env <<EOF
API_TOKEN=e2e-api-$(r 12 hex)
CREDENTIALS_KEY=$(r 32 base64)
AUTH_SECRET=$(r 32 base64)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=e2e-admin-$(r 6 hex)
PORT=3010
HOST=127.0.0.1
WORKER_INTERNAL_URL=http://127.0.0.1:9475
WORKER_HEALTH_PORT=9474
WORKER_INTERNAL_PORT=9475
WORKER_INTERNAL_HOST=127.0.0.1
WA_TRANSPORT=fake
ANTIBAN_MODE=real
CRM_BRIDGE=on
CONVERSATIONS_AUTO_ROTATE=false
GROUP_AUTOMATION_AUTO_ENABLE=false
AI_ENABLED=false
EOF
cat > $E2E/crm.env <<EOF
APP_NAME=CRM
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
API_PUBLIC_URL=http://localhost:5173/crm
WEB_PUBLIC_URL=http://localhost:5173/crm
CREDENTIALS_KEY=$(r 32 base64)
STORAGE_DIR=$E2E/crm-storage
WA_GATEWAY=rpc
WA_RPC_PROFILE=ai-manager
WA_RPC_URL=http://127.0.0.1:9475
CRM_QUEUE_PREFIX=crm
MAIL_TRANSPORT=memory
AI_MODE=fake
TRUST_PROXY=true
VITE_BASE_PATH=/crm/
VITE_API_BASE=/crm/api
CRM_WEB_PORT=5274
VITE_API_URL=http://127.0.0.1:3000
EOF
```

Portas: ai-manager api **3010** (a 3000 é da API do CRM, que o proxy do `apps/web` do CRM usa por padrão), worker
9474/9475, dashboard 5173, CRM api 3000, CRM web 5274.

**Redis exclusivo.** Os 16 dbs do Redis em 6379 costumam ter chaves de outros testes (inclusive streams `wsm:events:*`
e filas `crm-*`), então um `FLUSHDB` ali apagaria dados alheios. O roteiro sobe uma instância própria em **6390**, sem
persistência, e no fim só a derruba:

```bash
(cd $E2E/redis-data && redis-server --port 6390 --bind 127.0.0.1 --save "" --appendonly no --dir . > $E2E/logs/redis.log 2>&1 &)
```

**Git Bash + Windows:** o MSYS converte variáveis que começam com `/` em caminhos do Windows
(`VITE_BASE_PATH=/crm/` vira `C:/Program Files/Git/crm/`). O launcher abaixo exporta
`MSYS2_ENV_CONV_EXCL` para evitar isso.

## 1. Launcher

```bash
cat > $E2E/start.sh <<'EOS'
#!/usr/bin/env bash
# uso: start.sh <aim-worker|aim-api|aim-dash|crm-api|crm-worker|crm-web> [VAR=val ...]
E2E=$(cd "$(dirname "$0")" && pwd)
svc=$1; shift
set -a; . "$E2E/common.env"
case $svc in aim-*) . "$E2E/aim.env";; crm-*) . "$E2E/crm.env";; esac
for kv in "$@"; do export "$kv"; done
export MSYS2_ENV_CONV_EXCL="VITE_BASE_PATH;VITE_API_BASE;CRM_PUBLIC_PATH"
set +a
case $svc in
  aim-worker) cd $AIM/apps/worker && exec node $AIM/node_modules/tsx/dist/cli.mjs --conditions=development src/main.ts ;;
  aim-api)    cd $AIM/apps/api && exec node $AIM/node_modules/tsx/dist/cli.mjs --conditions=development src/server.ts ;;
  aim-dash)   cd $AIM/apps/dashboard && VITE_API_URL=http://127.0.0.1:3010 exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort ;;
  crm-api)    cd $CRM/apps/api && exec node $CRM/node_modules/tsx/dist/cli.mjs --conditions=development src/server.ts ;;
  crm-worker) cd $CRM/apps/worker && exec node $CRM/node_modules/tsx/dist/cli.mjs --conditions=development src/main.ts ;;
  crm-web)    cd $CRM/apps/web && exec node node_modules/vite/bin/vite.js --host 127.0.0.1 ;;
esac
EOS
chmod +x $E2E/start.sh
export AIM CRM
```

## 2. Banco exclusivo e migrations

```bash
# cria só o banco do teste (não toca wsm, wsm_backup_pre_vps, crm*, …)
node -e "const pg=require('$AIM/packages/db/node_modules/pg');const c=new pg.Client('postgres://wsm:wsm@127.0.0.1:5432/postgres');c.connect().then(()=>c.query('create database wsm_crm_e2e')).then(()=>c.end())"
# migrations do ai-manager (public.* + drizzle.__drizzle_migrations)
(cd $AIM && DATABASE_URL=postgres://wsm:wsm@127.0.0.1:5432/wsm_crm_e2e pnpm --filter @wsm/db migrate)
# só o set `crm` do CRM (schema crm.*)
cat > $CRM/apps/api/.e2e-crm-migrate.ts <<'EOF'
import { runMigrations } from '@crm/db'
await runMigrations(process.env.DATABASE_URL!, { set: 'crm' })
console.log('crm migrations ok')
EOF
(cd $CRM/apps/api && DATABASE_URL=postgres://wsm:wsm@127.0.0.1:5432/wsm_crm_e2e ../../node_modules/.bin/tsx --conditions=development .e2e-crm-migrate.ts; rm .e2e-crm-migrate.ts)
```

Obs.: a API e o worker do CRM chamam `runMigrations(db)` (set `all`) no boot. No banco do ai-manager o set `wa` do CRM
é no-op (mesmas 8 migrations, mesmos `created_at` em `drizzle.__drizzle_migrations`); confira se o ai-manager ganhar
migrations novas que o CRM não tem.

## 3. Subir os processos (ordem: worker do ai-manager antes do CRM)

```bash
cd $E2E
nohup ./start.sh aim-worker > logs/aim-worker.log 2>&1 &
nohup ./start.sh aim-api    > logs/aim-api.log 2>&1 &
sleep 15
nohup ./start.sh crm-api    > logs/crm-api.log 2>&1 &
nohup ./start.sh aim-dash   > logs/aim-dash.log 2>&1 &
nohup ./start.sh crm-web    > logs/crm-web.log 2>&1 &
sleep 20
nohup ./start.sh crm-worker > logs/crm-worker.log 2>&1 &
# PIDs (Windows) por porta, para parar depois
netstat -ano | grep LISTEN | grep -E ":(3000|3010|5173|5274|6390|9474|9475) "
```

Esperado nos logs: worker `CRM bridge on: events outbox and CRM RPC targets mounted`; CRM api `WaGateway configurado`
(`wa_gateway: rpc`); CRM worker `worker iniciado` com `consumer: true`.

Atalhos:

```bash
. $E2E/common.env; . $E2E/aim.env
A="Authorization: Bearer $API_TOKEN"; I="Authorization: Bearer $INTERNAL_TOKEN"
FAKE=http://127.0.0.1:9475/internal/fake/sessions
```

## 4. Cenário

1. **Painel + CRM via SSO**: abra `http://localhost:5173`, entre com `admin` / `$ADMIN_PASSWORD`, clique em **CRM**.
   O iframe abre `/crm/auth/sso#token=…` e cai no dashboard do CRM com a skin do ai-manager (empresa `ai-manager`).
2. **Chip falso conectado**: no CRM, **Conexões → Nova conexão** (cria a sessão no ai-manager via `sessions.create`)
   → menu da linha → **Conectar**. Pegue o `session_id` e simule QR e conexão pelo fake:

   ```bash
   SID=<session_id>   # select session_id from crm.connections
   curl -s -XPOST $FAKE/$SID/qr -H "$I" -H 'content-type: application/json' -d '{"qr":"2@FAKE-QR-E2E"}'
   curl -s -XPOST $FAKE/$SID/open -H "$I"
   ```

   A conexão fica **Conectada · Em aquecimento**. (Sessões criadas direto no ai-manager — `POST /api/sessions` — não
   aparecem no CRM: o CRM só lista o que está em `crm.connections`; ver "Lacunas".)
3. **Contato e fluxo**: **Contatos → Novo contato** (o CRM registra o consentimento no ai-manager por
   `contacts.recordConsent`). Fluxo pela API do CRM (cookie da sessão + `X-Requested-With: crm`), por exemplo do
   console do iframe:

   ```js
   const h = { 'X-Requested-With': 'crm', 'content-type': 'application/json' }
   const call = (m, p, b) => fetch('/crm/api' + p, { method: m, headers: h, credentials: 'include', body: b && JSON.stringify(b) }).then((r) => r.json())
   const { flow } = await call('POST', '/flows', { name: 'Resposta PROMO (E2E)' })
   await call('PUT', `/flows/${flow.id}/definition`, { schema: 'crm.flow/v1', entry: 'start', variables: [], refs: {},
     nodes: [ { id: 'start', type: 'start', name: 'Início', position: { x: 1200, y: 800 }, actions: [] },
              { id: 'msg', type: 'message', name: 'Resposta', position: { x: 1500, y: 800 },
                actions: [ { id: 'a1', type: 'send_message', order: 0, config: { message_text: 'Olá! Recebemos sua mensagem sobre a promo.' } } ] } ],
     edges: [ { id: 'e1', from: 'start', handle: 'source', to: 'msg' } ] })
   await call('POST', `/flows/${flow.id}/activate`)
   const conn = (await call('GET', '/connections')).items[0].id
   await call('PUT', `/connection-flow-configs/${conn}`, { keyword_triggers: [ { flow_id: flow.id, rule_type: 'any', conditions: [ { keyword: 'promo', match_type: 'contains' } ], active: true } ] })
   ```

4. **Inbound → fluxo → messages.send → status**:

   ```bash
   curl -s -XPOST $FAKE/$SID/receive -H "$I" -H 'content-type: application/json' \
     -d '{"id":"E2E-IN-001","from":"5511988887777@s.whatsapp.net","text":"Oi, quero saber da PROMO"}'
   sleep 12   # ANTIBAN_MODE=real atrasa o envio alguns segundos
   curl -s $FAKE/$SID/sent-history -H "$I"
   curl -s -XPOST $FAKE/$SID/receipt -H "$I" -H 'content-type: application/json' -d '{"messageId":"FAKE-OUT-2","status":"read"}'
   ```

   Conferir: `public.messages` (inbound `delivered` + outbound `sent`→`read`), stream `wsm:events`
   (`message.inbound`, `message.status` queued/processing/sent), `crm.messages` (outbound `sender_type=flow`,
   `status=read`), `crm.flow_runs` (`completed`, `trigger.type=keyword`) e **Chats ao vivo** no CRM.
5. **Limites**: `curl -s -XPUT http://127.0.0.1:3010/api/sessions/$SID/limits -H "$A" -H 'content-type: application/json' -d '{"perMinute":1}'`
   e mande duas mensagens seguidas pelo chat do CRM. A 2ª volta **429** e fica `failed` com
   `rate limit reached: 1/1 per minute` (o RPC devolve `SendRejectedError` `gate: rateLimit`). Direto no RPC:

   ```bash
   curl -s -XPOST http://127.0.0.1:9475/internal/rpc -H "$I" -H 'content-type: application/json' \
     -d "{\"target\":\"messages\",\"method\":\"send\",\"args\":[{\"sessionId\":\"$SID\",\"phone\":\"+5511988887777\",\"actor\":\"crm:e2e\",\"content\":{\"text\":\"x\"}}]}"
   ```

6. **CRM_BRIDGE=off**: pare só o worker (PID da porta 9475) e suba `./start.sh aim-worker CRM_BRIDGE=off`; reabra a
   sessão no fake (`$FAKE/$SID/open`). Envio pelo chat → **501** `CAPABILITY_NOT_SUPPORTED` (mensagem `failed`, o resto
   do CRM segue funcionando); RPC `messages.send` → `UNKNOWN_METHOD`; inbound não entra no stream (o `xlen` não muda).

## 5. Limpeza

```bash
# pare SÓ os processos iniciados por este roteiro (PIDs das portas acima), com a árvore:
for p in 3000 3010 5173 5274 9474 9475 6390; do
  pid=$(netstat -ano | grep LISTEN | grep "127.0.0.1:$p \|0.0.0.0:$p " | awk '{print $5}' | head -1)
  [ -n "$pid" ] && taskkill //PID $pid //T //F
done   # o crm-worker não escuta porta: ache o PID pelo comando (src/main.ts em apps/worker do CRM)
node -e "const pg=require('$AIM/packages/db/node_modules/pg');const c=new pg.Client('postgres://wsm:wsm@127.0.0.1:5432/postgres');c.connect().then(()=>c.query('drop database wsm_crm_e2e')).then(()=>c.end())"
rm -rf $E2E
```

## Lacunas conhecidas (vistas no E2E de 2026-10-17)

- **Chip criado no ai-manager não aparece no CRM.** `GET /api/connections` lista só `crm.connections`; não há
  "adotar" sessões de `public.sessions`. Hoje o caminho é criar a conexão pelo CRM (que cria a sessão no ai-manager).
- `contacts.list`, `media.download` e `messages.sendGroup` não são exercitados neste roteiro (cobertos pela suíte
  `tests/crm-contract`); `presence.update` é chamado pelo chat antes do envio, com erro ignorado.
- Capacidade ausente não tem indicação própria na UI do CRM: aparece como erro 501 no envio.
