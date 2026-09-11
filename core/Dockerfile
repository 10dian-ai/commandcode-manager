FROM node:24-alpine AS build
WORKDIR /build
COPY reference/commandcode-proxy-6217305 ./reference/commandcode-proxy-6217305
COPY scripts/build-core.mjs ./scripts/build-core.mjs
RUN node scripts/build-core.mjs

FROM node:24-alpine
WORKDIR /app
COPY --from=build /build/core/dist ./
ENV HOST=0.0.0.0 PORT=3050 CC_MAX_BODY_MB=64 LOG_FILE=""
USER node
EXPOSE 3050
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3050/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "proxy.mjs"]
