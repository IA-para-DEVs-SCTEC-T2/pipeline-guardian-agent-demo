# CopaFigurinhas

Aplicação full stack para gestão de um álbum de figurinhas da Copa: cadastre
jogadores, acompanhe **obtidas**, **faltantes** e **repetidas**, e gere um
relatório compartilhável.

Projeto didático, criado para uma aula de **CI/CD e agentes**. É simples de
entender, organizado e completo o suficiente para exercitar **testes, lint e
build**.

---

## Objetivo

- Demonstrar uma aplicação full stack pequena e legível.
- Servir de base para pipelines de CI/CD e automação com agentes (etapas
  posteriores da aula).
- Exercitar validação de dados, API REST e uma interface responsiva.

## Arquitetura

Monorepo com **npm workspaces**:

```
copa-figurinhas/
├── backend/    API REST em Node.js + Express (dados em memória)
└── frontend/   Interface em React + Vite
```

- **JavaScript com ES Modules** (sem TypeScript).
- Backend separa `app.js` (aplicação Express, testável) de `server.js`
  (inicialização do servidor).
- Dados vivem **em memória** — não há banco de dados.

## Tecnologias

| Camada    | Stack                                             |
| --------- | ------------------------------------------------- |
| Backend   | Node.js, Express, CORS, Zod, `node:test`, supertest |
| Frontend  | React, Vite, Vitest                               |
| Qualidade | ESLint (flat config), concurrently                |

## Instalação

Requer Node.js 20+ (testado com Node 22).

```bash
npm install
```

O comando na raiz instala as dependências de todos os workspaces.

Copie os arquivos de exemplo de variáveis de ambiente, se desejar:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

## Execução

Rodar backend e frontend juntos (concurrently):

```bash
npm run dev
```

- Backend: <http://localhost:3001>
- Frontend: <http://localhost:5173>

Rodar isoladamente:

```bash
npm run dev -w backend
npm run dev -w frontend
```

Validar o health check:

```bash
curl http://localhost:3001/api/health
```

## Endpoints

Base: `/api`

| Método | Rota                       | Descrição                                  | Sucesso |
| ------ | -------------------------- | ------------------------------------------ | ------- |
| GET    | `/health`                  | Status do serviço                          | 200     |
| GET    | `/stickers`                | Lista todas as figurinhas                  | 200     |
| GET    | `/stickers/:id`            | Detalha uma figurinha                      | 200     |
| POST   | `/stickers`                | Cria uma figurinha                         | 201     |
| PATCH  | `/stickers/:id/quantity`   | Incrementa/decrementa a quantidade         | 200     |
| DELETE | `/stickers/:id`            | Remove uma figurinha                       | 204     |
| GET    | `/report`                  | Relatório consolidado do álbum             | 200     |

`PATCH /stickers/:id/quantity` espera o corpo:

```json
{ "operation": "increment" }
```

ou

```json
{ "operation": "decrement" }
```

### Modelo da figurinha

```json
{
  "id": "uuid",
  "albumNumber": 1,
  "playerName": "Marcos Vieira",
  "country": "Brasil",
  "countryCode": "BR",
  "position": "goalkeeper",
  "quantity": 1,
  "duplicateCopies": 0,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

## Regras de negócio

- `albumNumber`: inteiro positivo e **único**.
- `playerName`: entre **3 e 80** caracteres.
- `country`: obrigatório.
- `countryCode`: exatamente **duas letras** (normalizado para maiúsculas).
- `position`: `goalkeeper`, `defender`, `midfielder` ou `forward`.
- `quantity`: inteiro **≥ 0**.
  - `0` = faltante · `1` = obtida sem repetidas · `> 1` = obtida com repetidas.
- `duplicateCopies` = `Math.max(quantity - 1, 0)`.
- Decremento **nunca** produz quantidade negativa.
- Item inexistente → **404**; entrada inválida → **400**; criação → **201**;
  exclusão → **204**.
- `GET /report` retorna `totalRegistered`, `obtained`, `missing`,
  `duplicateCopies`, `completionPercentage` (`obtained / totalRegistered * 100`,
  arredondado), `byCountry`, `missingStickers` e `duplicateStickers`.

## Scripts (raiz)

| Script            | Ação                                                   |
| ----------------- | ------------------------------------------------------ |
| `npm run dev`     | Backend + frontend em paralelo                         |
| `npm run lint`    | ESLint em todo o monorepo                              |
| `npm run test`    | Testes do backend e do frontend                        |
| `npm run build`   | Build de produção do frontend                          |
| `npm run ci`      | `lint` + `test` + `build` (usado no pipeline)          |

## ⚠️ Armazenamento em memória

Os dados são mantidos **apenas em memória** no processo do backend. **Reiniciar
o servidor recria os dados iniciais (seed) e descarta tudo que foi criado ou
alterado.** Não há persistência, banco de dados ou arquivo em disco — isso é
intencional para manter o projeto simples e focado na aula.
