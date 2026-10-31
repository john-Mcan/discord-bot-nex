# syntax=docker/dockerfile:1

# Compilacion: dependencias completas, TypeScript a dist/ y poda de las de desarrollo.
FROM node:22-slim AS build
WORKDIR /app
# .npmrc trae legacy-peer-deps (el motivo esta en el archivo).
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Ejecucion: solo dependencias de produccion (incluye el binario de ffmpeg-static),
# el codigo compilado y el logo. Los archivos quedan de root y el proceso corre
# como el usuario sin privilegios "node".
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
