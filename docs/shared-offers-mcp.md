# MCP de Ofertas

O patch `integrations/shared-offers/03-shared-offers-mcp.patch` acrescenta ferramentas de consulta e configuração ao servidor MCP existente do CRM. O manifesto fixa os bytes do patch e a árvore resultante; as duas entregas anteriores ficam intactas.

As três pessoas continuam na mesma conta administradora. Um conector OAuth pode ser autorizado pelos clientes dessa conta, com acesso de leitura ou escrita. A conexão usa a URL específica `/api/mcp/<id>`; nenhum token é publicado na documentação.

Consultas: `list_offers`, `get_offer`, `get_offer_resources`, `get_offer_results` e `list_conversation_offer_opportunities`. Configuração com escrita: `create_offer`, `update_offer` e `set_offer_connection_mode`. Recursos, validação, auditoria e permissões passam pela mesma API do painel. Ofertas só aparecem para a empresa habilitada no servidor. A nova oferta fica inativa por padrão; editar exige o estado de ativação explícito.

As ferramentas novas não iniciam fluxo ou cobrança e não enviam mensagem. Ativar uma oferta ou a modalidade do chip altera o tratamento das mensagens futuras e exige pedido explícito. As ferramentas de Sonda continuam separadas das Ofertas comerciais do CRM.

A atualização do instalador mantém a ativação já persistida. Ela compara a empresa entre estado, Compose e os dois containers antes de parar o CRM e depois do cutover. A árvore histórica da primeira instalação é aceita apenas como release já instalada; novos artefatos devem corresponder à árvore atual do manifesto. Storage e credenciais são preservados; a atualização não faz restore automático do banco compartilhado.

Os testes de MCP/autorização e os testes com PostgreSQL, Redis e providers fake são executados no GitHub Actions. No computador do usuário, apenas simulações leves Node/Git. O código contém oito cenários adicionais de aceitação e testes unitários do catálogo, schemas e rotas. A verificação publicada deve confirmar uma conexão MCP e uma consulta real permitida.
