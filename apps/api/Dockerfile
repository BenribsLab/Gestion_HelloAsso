FROM node:24.21.0-alpine3.23 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN npm run build --workspace @gestion/api

FROM node:24.21.0-alpine3.23 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @gestion/api --include-workspace-root \
    && npm cache clean --force

FROM node:24.21.0-alpine3.23 AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk upgrade --no-cache \
    && apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-fra tesseract-ocr-data-osd \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/migrations ./apps/api/migrations
# Aucune extension n'est plus construite ni activée par défaut : le dossier existe (requis par
# synchronizeBundledExtensions, qui échoue s'il est absent) mais reste vide. Chaque extension
# s'obtient désormais uniquement via achat + téléchargement signé sur le site de vente, installé
# depuis l'écran Extensions (POST /api/extensions/install, signature Ed25519 vérifiée).
RUN mkdir -p ./bundled-plugins ./plugins && chown node:node ./plugins
USER node
CMD ["node", "apps/api/dist/bootstrap.js"]
