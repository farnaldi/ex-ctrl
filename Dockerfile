# Railway (or any Docker host). `npm install` rather than `npm ci`: xlsx comes from the SheetJS CDN
# (the npm registry copy is outdated and vulnerable), and it is resolved at build time.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
