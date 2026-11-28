FROM node:22-alpine AS build
WORKDIR /crm
# Context is the reconstructed, sanitized CRM, never an operator checkout.
COPY . .
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile
RUN VITE_BASE_PATH=/crm/ VITE_API_BASE=/crm/api CRM_UI_SKIN=ai-manager pnpm --filter @crm/web build

FROM node:22-alpine AS release
ARG SOURCE_TREE
LABEL crm.source-tree=$SOURCE_TREE
# CRM-004: nota de voz (fluxo e chat) precisa do ffmpeg com libopus para converter MP3/M4A em Ogg/Opus.
RUN apk add --no-cache ffmpeg
WORKDIR /crm
COPY --from=build /crm /crm
CMD ["node", "/crm/node_modules/tsx/dist/cli.mjs", "--conditions=development", "/crm/apps/api/src/server.ts"]
