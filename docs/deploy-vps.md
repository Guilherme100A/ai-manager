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
