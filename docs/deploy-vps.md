# Deploy do ai-manager na VPS

O painel, API e worker deste repositório usam `docker-compose.yml` junto com
`docker-compose.crm.yml`. O CRM roda separadamente em `/home/ubuntu/crm`, com sua
SPA em `/home/ubuntu/crm-web-dist`; atualizar este repositório não substitui esses
diretórios, o banco, as sessões de WhatsApp nem os materiais das ofertas.

O workflow de deploy roda tipagem, lint e testes antes de chamar
`~/deploy-ai-manager.sh <SHA>`. Esse arquivo da VPS deve ser uma cópia de
`scripts/deploy-vps.sh` e ter permissão de execução.

Chaves SSH com comando fixo também são suportadas: o SHA é extraído de
`SSH_ORIGINAL_COMMAND` somente quando o pedido corresponde exatamente a
`~/deploy-ai-manager.sh <SHA completo>`. Nenhum comando recebido é avaliado como
shell.

A rotina valida o SHA, busca `origin/main`, recusa alterações locais não salvas,
troca para o commit informado e reconstrói somente worker, API e dashboard. A
configuração adicional do CRM permanece aplicada. O SHA só é registrado em
`~/.ai-manager-deployed` após o Compose concluir com sucesso.

Antes da primeira atualização de uma VPS com mudanças manuais, salve essas
mudanças em um commit local de backup e guarde os arquivos de ambiente fora do
Git. Não descarte modificações para fazer o deploy passar. Bancos, credenciais e
volumes de sessões não devem ser removidos ou reinicializados.

Verificação após deploy: compare o SHA do Git e do marcador com o workflow,
confira a saúde dos containers e abra painel, Espião e CRM em um navegador de
teste. Não envie WhatsApp, inicie sondas ou gere cobranças para testar o deploy.

`bash scripts/test-deploy-vps.sh` testa a rotina em um repositório descartável,
com Docker simulado, incluindo a recusa de alterações locais e SHA inválido.

## Proteção de disco antes do build (T006 R1)

Sob o mesmo `flock` existente, depois dos checks de origem, alterações locais e
manutenção, `deploy-disk.mjs` valida política e builder, mede o filesystem do
checkout/contexto e do `DockerRootDir` local, e libera o build somente quando
ambos passam. Um mesmo dispositivo é medido uma vez; livres de discos diferentes
nunca são somados. A medição Linux usa `df --local -B1
--output=avail,itotal,iavail` (disponível ao usuário, excluindo reserva root).
Falta de inodes aplicáveis ou falha de medição bloqueia.

A política externa padrão fica em `.config/ai-manager/deploy-disk.json` no home
do usuário efetivo, sem depender de `$HOME`. `AI_MANAGER_DISK_POLICY`, quando
definido, deve ser absoluto e externo ao checkout. Exemplo de formato, que **não
é criado automaticamente**:

```json
{"format":1,"observed_peak_bytes":0,"observed_peak_inodes":0}
```

Ausência usa esses defaults; zero significa ainda não medido. Se presente,
somente as três chaves são aceitas, sem duplicatas, strings, frações, negativos
ou overflow; limite 4096 bytes. Arquivo regular de UID efetivo e modo `0600`,
diretório dedicado `ai-manager` do mesmo UID e modo `0700`. `.config` pode ser
`0755`. Ancestrais devem pertencer ao UID efetivo ou root, sem escrita de grupo
ou outros e sem symlinks. O helper abre com `O_NOFOLLOW`, compara inode/dev do
descritor e valida ancestrais; não corrige permissões nem grava política.

Os pisos são `max(6442450944, observed_peak_bytes + 2147483648)` bytes e
`max(100000, observed_peak_inodes + 25000, ceil(total_inodes / 20))` inodes.
Bytes disponíveis abaixo de `8589934592` geram alerta mesmo passando o piso.
Esses pisos iniciais não garantem capacidade universal. O Integrador registra
manualmente picos realmente medidos durante o build, sob o mesmo lock,
preservando pelo menos o maior pico anterior; delta antes/depois não mede pico.

R1 aceita somente context `default`, endpoint Unix local e builder `default`,
driver `docker` e um único nó ativo no endpoint `default`. Confirma isso com
projeções de Docker e verifica `compose build --help` antes de passar
`--builder default` ao build existente de worker/api/dashboard, inclusive pelo
wrapper CRM. Overrides não vazios de `DOCKER_HOST`, `DOCKER_CONTEXT`,
`DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `BUILDX_BUILDER` e `COMPOSE_FILE` são
recusados, assim como `COMPOSE_BAKE` ativo e `DOCKER_BUILDKIT` diferente de `1`.
Depois da validação, fixa `DOCKER_CONTEXT=default`, `COMPOSE_BAKE=false` e
`DOCKER_BUILDKIT=1` apenas no processo de build/up, inclusive no wrapper CRM.
Não troca context/builder global. Topologias remotas ou não comprovadas bloqueiam.

Se qualquer piso falha, há no máximo uma tentativa de
`docker --context default builder prune --all --force`, somente cache de build
sem uso, seguida de nova medição de todos os dispositivos. Probes têm limite de
15 s; prune, 120 s. Prune iniciado com erro/sinal/timeout bloqueia mesmo que uma
medição diagnóstica posterior passe. Prune indisponível apenas avisa quando os
pisos já passam; abaixo deles, bloqueia. Nenhuma falha avança a build/up/marker.
O marker continua sendo escrito apenas depois de `up --wait` bem-sucedido.

**Precondição operacional para permitir prune:** Integrador confirma na
instalação que todos os builds desse builder usam o mesmo lock e que não há
build externo ativo, então fornece `AI_MANAGER_BUILDER_LOCK_CONFIRMED=1` ao
wrapper. Essa flag é declaração operacional, não prova de exclusão global.
Ausente: sem prune; build ainda permitido se os pisos passam.
`AI_MANAGER_BUILD_CONCURRENT=1` comunica atividade concorrente detectada e
sempre bloqueia prune, mesmo com a confirmação. Qualquer outro valor não vazio
além de `0` também bloqueia. Nenhum processo é morto e não há segundo lock.
Não se deve declarar exclusão apenas porque `ps` ou o lock não mostra atividade.

Logs JSON contêm fase, origem da política, identidade permitida, escopo de
filesystem, números, pisos, alertas, tentativa/resultado do prune e motivo de
gate. Não contêm caminhos completos, configuração/env/JSON bruto, argv nem
stdout/stderr Docker. Não introduz retenção de 2 GiB, daemon GC, cron, restart,
prune de imagens/volumes/containers ou remoção de runtime/rollback/dados/backups.
O orçamento `required_free_bytes` do receipt CRM continua validado pelo
instalador CRM, sem leitura ou alteração pelo gate do painel.

Validação local sem daemon: `node --test scripts/deploy-disk.test.mjs`,
`bash scripts/test-deploy-vps.sh` e
`node --test scripts/crm-release/release.test.mjs`. A suíte shell também usa o
`flock` real em Linux para provar serialização de dois wrappers; sem esse
binário, informa explicitamente o teste de concorrência não executado. Em
Windows, segurança POSIX e probes usam mocks; isso não valida a topologia VPS.
Antes de publicar, reconciliar main e exigir o CI integral no SHA final.
