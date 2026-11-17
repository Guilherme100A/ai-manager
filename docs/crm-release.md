# Release operacional de Ofertas compartilhadas

O uso solicitado é uma única conta de administrador, com o mesmo login e senha
usados por três pessoas em sessões simultâneas. Os chips são compartilhados e a
atribuição por oferta/conta XPag/pixel continua separada. As três sessões têm a
mesma identidade de responsável; não se criam três contas nem se atribui autoria
individual com base na sessão. As regressões com usuários distintos continuam
como cobertura adicional. Esta
mudança prepara instalação e recuperação; não altera ACL nem cria isolamento de
visibilidade entre administradores. A primeira instalação exige
`SHARED_OFFERS_COMPANY_ID` vazio. Atualizações preservam o UUID já confirmado e
persistido em `active.json`, conferindo API e worker antes e depois do corte.

## Artefato e CI

O job `crm-release` do workflow CI reutiliza
`scripts/prepare-shared-offers-crm.mjs`: reconstrói a distribuição sanitizada e
confere a árvore fixada em `integrations/shared-offers/manifest.json`. Não usa checkout
operacional do CRM nem seu histórico privado.

No runner GitHub, Postgres/Redis descartáveis exercitam backup/restore da fixture
com migrations públicas WA, dependência FK explícita entre public/crm, três
membros na mesma empresa, chip compartilhado e runs legados; depois 0038->0042,
backfill, idempotência, índices/triggers e restore de 0042. A perda de uma escrita
posterior ao dump demonstra o limite de RPO. É uma fixture sintética, não uma
certificação dos dados/reconciliação de toda a produção.

O ensaio usa `pg_dump` e `pg_restore` **do próprio container Postgres16 do job**,
com arquivos transmitidos por stdin/stdout em streaming. Não depende dos clientes
do PATH do Ubuntu. O CI exige major16 de ambos os clientes e servidor e registra
as versões efetivas em `migration-restore.json`; não instala clientes no PC.

O job executa suites existentes com provedores fake e Playwright isolado; adiciona
login painel->SSO->iframe->Ofertas e gate vazio, MCP read-only com initialize,
leitura permitida, escrita negada e revogação. Esses testes não usam provedores
externos nem tokens de produção.

Dependências executáveis da release são instaladas **dentro de node:22-alpine**.
Nenhum node_modules glibc do Ubuntu entra na imagem: `.dockerignore` exclui todos
os node_modules/dist do contexto. A SPA `/crm/` também é construída no Alpine.
O runner verifica importação via tsx e preenchimento do volume de dependências,
e resolve o Compose real com o override. Não há build/install na VPS.

Após sucesso são publicados `crm-release-<github.sha>` e evidências
`crm-verification-<github.sha>` por sete dias. O primeiro contém `images.tar.gz`,
`spa.tar.gz`, `release.json` e SHA256 do manifesto. O manifesto registra imagem
imutável, árvore CRM, plataforma linux/amd64 e as 43 migrations. A SPA separada é
para auditoria; a implantação copia a mesma SPA contida na imagem.

Artefato de PR é candidato. Para instalar, usar o artefato verde da revisão que
está efetivamente no painel após merge, com SHA correspondente. O workflow Deploy
continua usando exclusivamente o comando SSH fixo `~/deploy-ai-manager.sh SHA`.
Não foi acrescentado scp nem comando arbitrário nessa chave. Transferência do
artefato será feita pelo operador via acesso operacional já autorizado, depois
da revisão/CI; este código não transfere nem instala automaticamente o CRM.

## Preflight e autorização antes de qualquer instalação

Requisitos: Node 22 já disponível no host, Docker/Compose >=2.24.4, imagem nginx
já usada no ambiente, origem Git Guilherme100A, painel limpo e na revisão exata
do artefato, hashes/identidades aprovados e espaço suficiente. Não há instalação
automática desses requisitos. Sem release ativa, o wrapper do painel mantém o
caminho Docker original e não introduz dependência de Node no deploy legado.

O worker **principal** WhatsApp/RPC precisa estar running e healthy antes de
qualquer parada CRM, novamente antes da migração/corte e no final. Ausência,
exited ou unhealthy bloqueiam; o instalador CRM nunca reinicia esse worker.
A política `on-failure:3` adicionada somente ao Compose principal é recuperação
limitada de processo, não correção da causa TLS nem máscara global de exceções.
O deploy do painel já usa `--wait` e não pode considerar worker unhealthy pronto.

O operador deve renovar a observação de fontes (incluindo dirty/untracked src),
journal, mounts e gates e conciliá-la com a revisão. O recibo tem prazo de 15min;
se houver drift deve ser renovado/revisado, não apenas editado para forçar passagem.
Um digest é comparação temporal, não assinatura/autenticidade do servidor.

Comandos **futuros**, só depois de revisão, CI verde e autorização de instalação:

```bash
# Arquivos operacionais ficam fora do Git e protegidos com umask 077.
umask 077
node scripts/crm-release/capture.mjs "$PANEL_DIR" "$LEGACY_CRM_DIR" "$STATE_DIR" "$BACKUP_DISK_BUDGET_BYTES" > "$RECEIPT_FILE"
# Revisar o recibo e estabelecer RPO/janela; ack_shared_database_rpo nasce false.
# Aprovação humana explícita altera esse campo para true. Não há autoaprovação.
bash scripts/crm-release/deploy.sh --apply "$PANEL_DIR" "$STATE_DIR" "$ARTIFACT_DIR" "$MANIFEST_SHA256_FROM_CI" "$RECEIPT_FILE" "$VERIFIED_GIT_REMOTE"
```

`STATE_DIR` é dedicado e externo ao checkout. Repo, estado, CRM legado e artefato
devem ser diretórios fisicamente separados,
sem igualdade nem ancestralidade entre eles; o recibo é arquivo separado fora
dos quatro. A validação resolve ancestrais existentes e symlinks/junctions antes
de qualquer efeito externo. Endpoints mutáveis do estado/`releases` e bootstrap
não podem redirecionar escritas por symlink/junction. Nada é movido ou apagado
para corrigir uma localização recusada.

O orçamento de disco deve incluir
imagem descompactada, novo volume deps, dados/dirty/untracked do CRM antigo,
dump completo do banco compartilhado, storage e Redis, mais margem operacional.
O script compara o orçamento com o espaço livre, mas não estima automaticamente
a compressão/crescimento de todos esses dados. RAM/carga/discos Docker e host
precisam ser medidos na janela; teste de recurso não substitui esse planejamento.

## Ordem efetiva e persistência

`deploy.sh` exige `--apply` e adquire o mesmo flock do painel, sem esperar se
ocupado. O módulo Node recebe um executor que os testes substituem por mocks.
O executor real nunca imprime config/env/erros de subprocessos com credenciais.
Gates e cinco segredos obrigatórios são comparados entre containers e Compose
em memória; os valores nunca entram no manifesto ou relatório.

1. Conferir recibo, SHA256, origem/head/dirty/fontes, worker principal, gates,
   credenciais, journal 39 (ou 43 em release já gerenciada) e storage existente.
2. Criar candidato novo sem sobrescrever pastas/volumes existentes, carregar e
   conferir a imagem auditada, criar volumes deps/SPA exclusivos e copiar SPA CI.
3. Resolver e validar o override: nenhuma montagem do checkout antigo em `/crm`,
   deps imutáveis por release, volume storage original preservado em API/worker.
4. Preservar bootstrap/driver anteriores e seus hashes, instalar proteção externa
   e gravar manutenção **antes de qualquer parada CRM**. Depois tentar parar
   somente crm-api/crm-worker. Registrar tentativa antes do comando:
   falha parcial também entra em recuperação e verificação de estado real.
5. Fazer dump completo e TOC (`pg_restore --list`, sem restore), tar do CRM antigo
   com dirty/untracked, storage, snapshot Redis por full-sync, `.env`/Compose e
   configuração. Diretório protegido, checksums streaming em blocos de1MiB.
6. Manter proteção/driver já instalados, atualizar estágio de manutenção e usar
   apenas `--set crm`.
   Conferir journal43, coluna, trigger e índices antes do corte.
7. Publicar `active.json` atomicamente; subir somente CRM API com health e até3
   tentativas da mesma imagem, depois worker/web. Conferir imagem/mounts/env/gate
   dos containers efetivos, SPA HTTP e novamente principal saudável.
8. Gravar atomicamente o resultado final e só depois limpar manutenção. Falha de
   gravação (EEXIST/disco cheio) mantém o bloqueio; erro pós-migração que encontre
   marcador ausente o repõe antes de pausar o CRM. O marcador prevalece sobre um
   arquivo de resultado que eventualmente já exista.

`active.json`, driver e overrides ficam fora de Git. O bootstrap preserva os dois
modos do comando SSH fixo e chama o driver externo. O próximo deploy do painel
recusa manutenção já no bootstrap real e novamente após adquirir o flock,
antes de Git/Docker. Assim stop parcial ou backup com recuperação falha também
bloqueia o comando fixo seguinte, sem depender de chamar `invoke()` diretamente.
O próximo deploy
usa o override ativo; checkout de revisão sem integração é recusado. O serviço
`crm-web-build` passa a apenas copiar a SPA **da mesma imagem CI** para o volume
SPA da release. Não compila, não instala, não usa fontes/deps/volume SPA antigos.

Não se apagam imagens, volumes, backups ou fontes anteriores automaticamente.
Containers CRM worker/web sem healthcheck são reportados como running, nunca
healthy inventado. O resultado exige observação operacional, UI/MCP e logs/filas
novos após o deploy; HTTP200 ou o deploy antigo do painel não provam ponta a ponta.

## Recuperação e limites

Antes de qualquer tentativa de migração: recuperar somente o CRM antigo e
verificar API healthy/worker running. Se recuperação parcial falhar ou estado
não puder ser comprovado, manter `maintenance.json` e recusar o deploy seguinte.
Os testes modelam worker parado antes de o comando stop retornar erro.

Depois que a migração foi tentada, uma falha pode ter commit desconhecido. O
instalador mantém manutenção, pausa somente o CRM e conserva imagem/schema/IDs.
Nunca faz downgrade binário, DROP, down -v, FLUSHDB, purge de outbox ou restore
automático. `active.json` pode já apontar para candidato novo: não removê-lo para
forçar runtime antigo sobre schema0042. Retentar API saudável dentro da mesma
execução é limitado; repetir a instalação sobre candidato existente é recusado
e exige conciliação explícita. A idempotência do migrator é ensaiada no CI.

Banco e Redis são compartilhados com o painel, cujas escritas continuam durante
a manutenção CRM. Seus snapshots não formam ponto atômico conjunto. Um restore
produtivo requer autorização específica, RPO aceito, parada coordenada de todos
os escritores, conciliação de filas/streams/leases/IDs e ensaio prévio em banco
separado. O backup não elimina escritas posteriores nem risco de reenvio externo.
Preservar os backups protegidos e providenciar cópia externa/retention pelo
procedimento do operador; este script não envia dados para serviço externo.

Nenhum UUID real é incluído. Ativação é decisão separada e requer confirmação da
empresa, gates iguais e autorização. B01-B04 exigem resultados reais do CI e
revisão; B05 exige preflight/autorizações e verificação publicada novos.

Após instalar e verificar com gate vazio, a ativação autorizada registra
`company_id` canônico no estado externo e regenera o override pelo mesmo helper.
O wrapper confere a igualdade desse arquivo e preserva o gate nos dois serviços
no próximo deploy. A alteração deve ocorrer sob o mesmo flock e marcador de
manutenção, com cópia do estado/override anterior e conferência da empresa no
banco; reiniciar somente CRM API/worker e confirmar os dois valores antes de
liberar manutenção. O instalador não ativa por conta própria, nem aceita atualizar
uma release já ativada sem conciliar explicitamente seu estado.

O workflow manual `Verify live CRM` roda Playwright no GitHub contra a VPS após
publicação e ativação. Usa `CRM_SMOKE_PANEL_TOKEN`, sessão administrativa temporária
assinada para essa verificação, fornecida como secret criptografado e removida pelo
operador ao terminar. Nenhuma senha ou chave de assinatura é copiada ao GitHub.
O teste abre três sessões CRM da mesma conta, lê Ofertas/chips e verifica logout
isolado. Bloqueia escritas de negócio, encerra suas sessões e revoga o token do
painel. Não publica capturas nem dados de clientes nos logs.

## Simulação leve, sem infraestrutura

```bash
node --test scripts/crm-release/release.test.mjs
bash scripts/test-deploy-vps.sh
```

Node executa o mesmo coordenador com executor falso e filesystem descartável;
exercita chamadas/ordem, dados e falhas antes/depois de efeitos parciais. Git Bash
exercita os wrappers em repositórios **locais temporários** e mocks Docker/Node/
flock; não há push GitHub, build, conexão VPS nem daemon. Os testes recusam
remote errado, dirty/drift, lock ocupado, gate, backups/TOC vazios, schema/health,
credenciais/mounts e recuperação insegura. Não equivalem ao ensaio real do CI.
