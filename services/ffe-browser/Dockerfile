# Image officielle Playwright : Chromium + toutes les dépendances système nécessaires déjà
# installées. Volontairement pas Alpine (comme le reste de la stack) : le support musl de
# Chromium n'est pas fiable, Microsoft ne publie que des images Debian/Ubuntu pour Playwright.
# Garder ce tag synchronisé avec la version de "playwright" dans package.json.
FROM mcr.microsoft.com/playwright:v1.55.1-noble AS dependencies
WORKDIR /app
COPY services/ffe-browser/package.json services/ffe-browser/package-lock.json ./services/ffe-browser/
RUN npm ci --prefix services/ffe-browser

FROM dependencies AS build
# tsconfig.json du service référence "../../tsconfig.base.json" : garder la même structure de
# dossiers que le dépôt dans l'image (comme apps/api/Dockerfile), pas un WORKDIR aplati, sinon
# "extends" échoue silencieusement et skipLibCheck ne s'applique plus.
COPY tsconfig.base.json ./
COPY services/ffe-browser/tsconfig.json ./services/ffe-browser/tsconfig.json
COPY services/ffe-browser/src ./services/ffe-browser/src
RUN npm run build --prefix services/ffe-browser

FROM mcr.microsoft.com/playwright:v1.55.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/services/ffe-browser/node_modules ./node_modules
COPY services/ffe-browser/package.json ./
COPY --from=build /app/services/ffe-browser/dist ./dist
RUN mkdir -p /data/sessions && chown pwuser:pwuser /data/sessions
USER pwuser
CMD ["node", "dist/server.js"]
