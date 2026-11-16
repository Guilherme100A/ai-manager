# Ofertas com chips compartilhados

O painel e o CRM continuam em repositórios separados. O painel abre o CRM por SSO; WhatsApp continua no worker do painel, pelo SendPipeline e bridge existentes. Nenhum roteamento de pagamentos ou eventos é implementado no painel.

## Preparação reproduzível

Execute **node scripts/prepare-shared-offers-crm.mjs ../crm-shared-offers** em um clone deste repositório. O destino deve ser novo. O script obtém a base pública exata do CRM e verifica SHA256 e aplicabilidade de cada patch antes de aplicá-lo, na ordem do manifesto em integrations/shared-offers. Não inicia serviços ou migrações.

O primeiro patch entrega uma projeção sanitizada dos **pré-requisitos e mudanças locais preexistentes**, incluindo a implementação de ofertas anteriormente revisada e outras correções do CRM. Ele não representa trabalho novo desta tarefa. Scripts operacionais e harnesses de auditoria alheios foram excluídos; hosts operacionais em documentação e fixtures de URL foram substituídos por domínios reservados `example.test`. A relação completa está em `sanitization` no manifesto. Os originais locais permanecem preservados. O segundo patch contém o gate por empresa, compatibilidade de runs e verificações desta entrega. O script também confere a árvore Git reconstruída contra `expected_tree`, que representa a distribuição sanitizada. A separação permite auditar a cadeia completa sem copiar o CRM inteiro para o painel. Leia também docs/shared-offers.md do CRM reconstruído para o comportamento funcional.

## Autorização da empresa

Login, SSO e GET de perfil recebem as capabilities calculadas pelo mesmo produtor de resumos de empresas no servidor. Assim, o perfil inicial gravado no cache do navegador já inclui `shared_offers` para cada empresa, sem reload ou refetch adicional. O cadastro mantém o contrato existente de usuário e mensagem; a troca de empresa mantém seu contrato e atualiza a sessão pelo GET de perfil.

SHARED_OFFERS_COMPANY_ID deve conter um único UUID CRM confirmado pelo operador. A configuração vazia ou inválida desliga a modalidade. Este pacote não configura um UUID de produção. Configure o mesmo valor no crm-api e crm-worker; docker-compose.crm.yml propaga o valor do ambiente. O nome interno, email, usuário admin, header do cliente ou claim SSO não autorizam a modalidade. O CRM valida a membership e a empresa ativa antes do gate backend. A capability devolvida no perfil só controla apresentação da UI; o backend revalida cada operação.

No CRM autorizado: Ofertas permite CRUD, chips compartilhados, vínculos de origem, seleção manual e resultados separados por responsável e moeda. Origem ausente/conflitante bloqueia automação de oferta. Snapshots preservam pagamento/pixel/responsável e Purchase usa outbox canônica. Apenas runs com oportunidade validada têm exclusividade por chat. Um novo run comum conflita com qualquer run ativo do contato, inclusive ofertas em outro chat. Um novo run de oferta conflita com qualquer legacy do contato ou outra oferta no mesmo chat; duas ofertas em chats distintos podem coexistir. A trava transacional aplica essas regras em ambas as ordens e na concorrência, com e sem chat no legacy.

## Desativação e recuperação

Ao retirar a configuração, novas operações de oferta recebem 404 e a UI desaparece. Outbox pendente permanece no banco e não é enviada. Jobs de entrega já enfileirados deixam diagnóstico de entrega pausada e preservam o mesmo event_id/destino. A varredura só reserva eventos da empresa autorizada. Reativar o mesmo UUID retoma pendências com os IDs originais. Callbacks de oferta que precisem produzir evento falham transacionalmente e ficam sujeitos ao retry durável existente; acompanhe filas/falhas antes de desligar. Não remova outbox, oportunidades ou vendas para desativar a modalidade.

## Publicação

O workflow Deploy dispara em push para main e workflow_dispatch. Nenhum desses caminhos deve ser usado nesta etapa. Testes locais e auditoria Revisor + conferência Planner precedem qualquer push autorizado. Futuro deploy precisa alinhar migrations CRM, API, worker e SPA e verificar o resultado publicado. O deploy do painel não atualiza automaticamente /home/ubuntu/crm nem sua SPA.

Nenhuma cobrança, mensagem ou evento real é necessário aos testes: usar HTTP Meta/XPag falsos, Postgres/Redis descartáveis e Playwright separado. Aceite/atribuição/aprendizado Meta reais permanecem não certificados.

O manifesto destaca em `test_only_changes` a correção autorizada da fixture preexistente de cota administrativa: somente o relógio Date da leitura cliente é alinhado ao relógio fixo do admin, mantendo o assert de bônus 250. O código de produção de cotas não foi alterado.

O mesmo manifesto registra o ajuste da expectativa exata do resumo de suporte para incluir `shared_offers: false` fora da empresa alvo, preservando os asserts de permissões e concessão. Essa atualização altera somente o teste.
