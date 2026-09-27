# syntax=docker/dockerfile:1

# ---------- estágio 1: build (tem devDependencies e o compilador TypeScript) ----------
FROM node:22-alpine AS build
WORKDIR /app
# Copia só os manifests antes do código: a camada do npm ci fica em cache
# enquanto package*.json não mudar.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- estágio 2: runtime (só JS compilado + dependências de produção) ----------
FROM node:22-alpine AS runtime
# npm/yarn/corepack não são usados em runtime: removê-los reduz tamanho e superfície de ataque.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
# Arquivos ficam com dono root e só leitura para o usuário da aplicação.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
# Usuário não-root que já existe na imagem oficial do Node (uid 1000).
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health > /dev/null || exit 1
CMD ["node", "dist/server.js"]
