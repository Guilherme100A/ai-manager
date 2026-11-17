# Áreas Admin 1 / Admin 2 / Admin 3

Uma conta administradora da empresa habilitada pode organizar três áreas de negócio. Isso não cria três usuários ou identidades pessoais. As três pessoas usam o mesmo login e podem selecionar qualquer uma das três áreas. A seleção é independente por aba/dispositivo.

A conta autorizada é a proprietária única (`owner`) da empresa já habilitada pelo gate compartilhado. Outro membro, outro administrador com permissões completas, suporte ou usuário de outra empresa não recebe as ferramentas MCP de áreas. A API revalida a identidade e a empresa; esconder o menu não é a proteção. Depois de configurar áreas, recursos financeiros/fluxos dessa empresa ficam restritos a essa conta. Chats e o chip continuam compartilhados conforme as permissões existentes.

Em **Ofertas → Organizar Admin 1 / Admin 2 / Admin 3**, criar as áreas não move cadastros atuais. Eles permanecem em **Sem área**. Selecione explicitamente uma área, informe nome e BM e atribua recursos já cadastrados. Um recurso pertence a uma única área e não é transferido automaticamente. Um chip pode ser usado nas ofertas de todas as áreas.

A BM é um ID organizacional declarado. Não é uma nova autorização OAuth, verificação de propriedade na Meta ou concessão de acesso a uma BM. As contas de anúncios continuam sendo as realmente conectadas pelo OAuth existente. Nome/ID de BM, XPag, pixel e conta de anúncio não compartilham segredos entre áreas.

Para uma oferta existente, **Confirmar atribuição da oferta e recursos** atribui o conjunto completo em uma transação. Recursos usados por outra oferta/área impedem a operação inteira. Não ativa oferta, não troca destinos, não inicia fluxo e não reescreve oportunidades ou vendas anteriores. O histórico anterior à divisão permanece em Sem área; novos snapshots incluem área, nome e BM vigentes no momento da oportunidade.

Na área selecionada, as listas e seletores mostram apenas os respectivos produtos, fluxos, pagamentos, contas, pixels e links. A API recusa IDs de outra área, referências cruzadas em nós de fluxo e destinos de pagamento/pixel/fluxo definidos por expressão. Fluxos podem ser criados, editados, validados e simulados pelo MCP; a ativação continua sendo uma ação explícita. Integrações globais de nota fiscal/UTMify não são destinos de uma área nesta versão.

## MCP

O conector OAuth existente continua o mesmo. A autorização usa a conta admin existente. Não crie três conectores ou compartilhe tokens no chat.

- `list_business_areas`: IDs reais das três áreas.
- `initialize_business_areas`: cria as três áreas sem mover dados.
- `configure_business_area`: nome e BM declarada.
- `get_business_area_resource_catalog`: catálogo administrativo de recursos e suas atribuições, sem segredos.
- `assign_business_area_resource`: atribuição explícita; recusa transferência.
- `adopt_offer_business_area`: atribui oferta e conjunto inteiro com `confirm:true`.

Informe `business_area_id` **em cada chamada** de Ofertas, fluxos, pixels, pagamentos e métricas de anúncios. O servidor não mantém uma área global na credencial: chamadas simultâneas de duas pessoas não trocam o contexto uma da outra. Omitir a área depois da configuração usa somente cadastros sem área. A credencial de leitura não recebe as operações de escrita.

Exemplo de pedido: “Liste as áreas. Usando o ID do Admin 1, consulte os recursos e monte um fluxo em rascunho com a XPag e o pixel dessa mesma área; valide e simule, sem ativar ou enviar mensagens.”

## Publicação

Patch aditivo sobre o CRM completo 6844, preservando MCP Ofertas/chips e login persistente. Nova migration CRM `0043_business_areas`; o prefixo anterior de 43 migrations não muda. Não aplica migrations WA/public pelo instalador CRM. Build, banco, Redis e Playwright somente no CI; pós-deploy real obrigatório. Repetir preflight de saúde e espaço antes de qualquer build na VPS. Não fechar entrega com apenas sintaxe/lint ou compilação.
