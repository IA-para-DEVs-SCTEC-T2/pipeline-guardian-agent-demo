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
├── backend/      API REST em Node.js + Express (dados em memória)
├── frontend/     Interface em React + Vite
└── automation/   Agente Pipeline Guardian (diagnóstico de CI/CD)
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

| Script                          | Ação                                                    |
| ------------------------------- | ------------------------------------------------------- |
| `npm run dev`                   | Backend + frontend em paralelo                          |
| `npm run lint`                  | ESLint em todo o monorepo                               |
| `npm run test`                  | Testes do backend, do frontend e do agente              |
| `npm run build`                 | Build de produção do frontend                           |
| `npm run ci`                    | `lint` + `test` + `build` (usado no pipeline)           |
| `npm run agent:analyze`         | Agente sobre a execução real do pipeline                |
| `npm run agent:fixture -- test` | Agente sobre um cenário simulado                        |

---

## Agente Pipeline Guardian (`automation/`)

Recebe **metadados do pipeline, logs dos comandos e o diff da Pull Request** e
produz um diagnóstico estruturado — em JSON e em Markdown.

```bash
npm run agent:fixture -- test     # cenário simulado
npm run agent:analyze             # executa o pipeline de verdade e analisa o resultado
```

Saídas: `reports/diagnosis.json` e `reports/diagnosis.md`.

### Funciona com ou sem chave da OpenAI

| Cenário                                    | Comportamento                                     |
| ------------------------------------------ | ------------------------------------------------- |
| `OPENAI_API_KEY` + `OPENAI_MODEL` definidos | Responses API com saída estruturada validada (Zod) |
| Sem chave, erro de rede ou saída inválida   | **Classificador determinístico** (`usedFallback: true`) |

Em qualquer um dos dois, a saída é válida contra o mesmo schema. O agente
degrada, não quebra.

### Três garantias

1. **Segredo nenhum sai daqui.** Chaves, `Bearer`, `ghp_`/`github_pat_`, `sk-`,
   variáveis `PASSWORD`/`SECRET`/`TOKEN`, credenciais em URL e cookies viram
   `[REDACTED]` **antes** de irem ao modelo, ao disco ou ao relatório.
2. **O modelo não decide deploy.** Ele descreve a falha; a decisão
   (`eligible_for_staging`, `blocked`, `requires_human_approval`) é de uma
   política determinística aplicada **depois**, que sobrescreve qualquer
   recomendação insegura. Lint, teste, build, permissão, segurança, confiança
   baixa ou limitação relevante ⇒ `blocked`. Produção ⇒ sempre aprovação humana.
3. **Evidência não se inventa.** Cada trecho citado é conferido contra o material
   coletado; o que não existe lá é descartado e declarado como limitação.

### Cenários simulados

`lint`, `test`, `dependency`, `build`, `environment`, `permission`, `security`,
`unknown` e `success`.

### Configuração

Tudo é opcional — copie `automation/.env.example` para `automation/.env` se quiser
usar o modelo. O agente **não faz deploy** e **não comenta na PR** sem opt-in
explícito (`AUTOMATION_ALLOW_PR_COMMENT=true` + `GITHUB_TOKEN`).

## ⚠️ Armazenamento em memória

Os dados são mantidos **apenas em memória** no processo do backend. **Reiniciar
o servidor recria os dados iniciais (seed) e descarta tudo que foi criado ou
alterado.** Não há persistência, banco de dados ou arquivo em disco — isso é
intencional para manter o projeto simples e focado na aula.
