FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN bun install
COPY . .
RUN bun run dashboard:build

FROM oven/bun:1 AS server
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/packages ./packages
RUN mkdir -p /data
ENV LOG_ARITHMIC_HOST=0.0.0.0
ENV LOG_ARITHMIC_DATABASE=/data/log-arithmic.sqlite
EXPOSE 8787
CMD ["bun", "apps/server/src/index.ts"]

FROM nginx:1.27-alpine AS dashboard
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
