# CLAUDE.md — CopaFigurinhas

Contexto para agentes e para quem for evoluir este repositório.

## Decisões arquiteturais

- **Monorepo com npm workspaces** (`backend`, `frontend`). A raiz orquestra os
  scripts; cada workspace tem o seu `package.json`.
- **JavaScript + ES Modules** em todo o projeto. **Não usar TypeScript.**
- **Backend**: Express com `app.js` (cria e configura a aplicação, sem abrir
  porta) separado de `server.js` (chama `listen`). Essa separação permite testar
  a API com supertest sem subir rede.
- **Validação com Zod** centralizada em `backend/src/schemas.js`. Erros de
  validação são convertidos para resposta HTTP 400 no `errorHandler`.
- **Dados em memória** no `backend/src/store/store.js`. `resetStore()` recria o
  seed e é usado nos testes.
- **Regras de negócio derivadas** (ex.: `duplicateCopies`, relatório) ficam em
  `backend/src/services/report.js` — funções puras, fáceis de testar.
- **Frontend**: React + Vite. Lógica pura (filtros, iniciais, texto do
  relatório) isolada em `frontend/src/utils.js` para permitir testes unitários
  sem DOM. Chamadas HTTP centralizadas em `frontend/src/api.js`.
- **Compartilhamento** via `navigator.share` com fallback para
  `navigator.clipboard.writeText` — sem bibliotecas externas.
- **CSS puro** com variáveis (paleta esportiva). Sem framework CSS, sem imagens
  externas: iniciais, badges e chips desenhados via CSS.

## Comandos principais

```bash
npm install            # instala todos os workspaces
npm run dev            # backend + frontend (concurrently)
npm run lint           # ESLint no monorepo
npm run test           # testes backend (node:test) + frontend (vitest)
npm run build          # build do frontend
npm run ci             # lint + test + build
```

Por workspace: `npm run <script> -w backend` ou `-w frontend`.

## Padrão de nomes

- Arquivos JS utilitários e de configuração: `camelCase.js` / `kebab` quando fizer sentido.
- Componentes React: `PascalCase.jsx`.
- Testes: `*.test.js` (backend em `backend/test/`, frontend ao lado do módulo).
- Endpoints REST em inglês sob `/api`; posições em inglês
  (`goalkeeper`, `defender`, `midfielder`, `forward`).
- Respostas de erro padronizadas: `{ error: { code, message, details? }, requestId }`.

## Restrições

- **Não** fazer commit, push ou abrir Pull Request automaticamente.
- **Não** introduzir agente de IA nem GitHub Actions nesta etapa.
- **Não** usar APIs externas nem buscar imagens da internet.
- **Não** imprimir `Authorization`, cookies ou corpo de requisição nos logs.

## Regra: nada de banco, autenticação ou Docker

Este projeto é **deliberadamente simples**. **Não introduza**:

- **banco de dados** ou qualquer persistência em disco — os dados são em memória;
- **autenticação/autorização** — não há usuários nem sessões;
- **Docker** ou orquestração de containers.

Se uma dessas necessidades surgir, ela pertence a uma etapa futura e deve ser
discutida antes — não adicione por conta própria.
