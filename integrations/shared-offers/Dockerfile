FROM node:22-alpine AS build
WORKDIR /crm
# Context is the reconstructed, sanitized CRM, never an operator checkout.
COPY . .
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile
RUN VITE_BASE_PATH=/crm/ VITE_API_BASE=/crm/api pnpm --filter @crm/web build

FROM node:22-alpine AS release
ARG SOURCE_TREE
LABEL crm.source-tree=$SOURCE_TREE
WORKDIR /crm
COPY --from=build /crm /crm
CMD ["node", "--conditions=development", "/crm/node_modules/tsx/dist/cli.mjs", "/crm/apps/api/src/server.ts"]
