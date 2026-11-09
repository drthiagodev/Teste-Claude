# Carteira — app para celular

App instalável (PWA) que roda o painel **Carteira Pessoal** do Claude fora do Claude, no celular.

## Como funciona

- `painel.html` é cópia **sem alterações** da página do painel. Para atualizar o app depois de mudar o painel, basta substituir este arquivo.
- `dash-shim.js` recria no navegador as funções que o painel usa no Claude (`dash.data`, `draw`, `calc`, `loader`, `colors`, `setLink`).
- `index.html` é a casca: barra com **Atualizar** e **Dados**, cores claro/escuro e ajustes de toque.
- `sw.js` guarda os arquivos para o app abrir sem internet.

## Dados

| Fonte | De onde vem |
|---|---|
| Cotações e preços semanais | Planilha Google “Carteira Pessoal – Cotações”, lida a cada atualização |
| Lançamentos, proventos, a receber, posição na corretora, RDCs, preços B3, índices BCB | Pacote `carteira-dados.json`, importado uma vez no aparelho |

O pacote fica só no aparelho (IndexedDB). **Nunca** entra no repositório (`.gitignore` bloqueia `*.csv` e `carteira-dados*.json`).

A leitura da planilha exige compartilhamento “Qualquer pessoa com o link: leitor”.

## Instalar no celular

1. Abra o endereço onde o app estiver hospedado.
2. iPhone: Compartilhar → “Adicionar à Tela de Início”. Android: menu → “Instalar app”.
3. Toque em **Dados** → importe `carteira-dados.json`.
