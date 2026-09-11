FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/.output ./.output
COPY --from=build /app/.worker ./.worker
COPY --from=build /app/db ./db
COPY ops/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
