# syntax=docker/dockerfile:1

# CopaFigurinhas — imagem de produção.
#
# UM container, UMA aplicação: o Express serve a API em `/api` e o frontend
# compilado (`frontend/dist`) no mesmo domínio e na mesma porta. Não há serviço
# separado para o frontend, não há banco de dados e não há volume: os dados
# vivem em memória e somem quando o processo reinicia (decisão didática,
# documentada no README).
#
# O build acontece AQUI, no estágio `build`. O container de execução não
# instala dependência, não roda teste e não compila nada — só inicia o servidor.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# deps — dependências completas (com devDependencies) para compilar o frontend.
#
# Só os `package.json` são copiados antes do `npm ci`: enquanto eles e o
# lockfile não mudarem, esta camada é reaproveitada do cache.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY automation/package.json automation/package.json

RUN npm ci

# ---------------------------------------------------------------------------
# build — compila o frontend com o Vite.
#
# `VITE_API_URL` fica deliberadamente indefinido: sem base, o cliente HTTP usa
# caminho relativo (`/api`), que é exatamente o que queremos quando API e SPA
# compartilham o mesmo domínio.
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app

COPY frontend/ frontend/

RUN npm run build -w frontend

# ---------------------------------------------------------------------------
# runtime-deps — apenas as dependências de produção do backend.
#
# `--omit=dev` remove Vite, Vitest e ESLint; `--workspace backend` deixa de
# fora as dependências de runtime dos outros workspaces (o cliente da OpenAI do
# agente, por exemplo, não tem o que fazer dentro da aplicação).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime-deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY automation/package.json automation/package.json

RUN npm ci --omit=dev --workspace backend --ignore-scripts \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime — imagem final.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

# A árvore inteira do estágio anterior: `node_modules` da raiz, os `package.json`
# dos workspaces (sem eles os symlinks de workspace não resolvem) e eventuais
# `node_modules` por workspace que o npm decidiu não içar para a raiz.
COPY --from=runtime-deps /app ./

COPY backend/src ./backend/src
# COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/frontend/build ./frontend/dist

# `node` (uid 1000) já existe na imagem oficial. A aplicação não escreve em
# disco, então o conteúdo copiado pode continuar pertencendo ao root: o
# processo só precisa de leitura.
USER node

EXPOSE 3001

# Health check pelo próprio Node — sem curl, sem wget na imagem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "backend/src/healthcheck.js"]

CMD ["node", "backend/src/server.js"]
