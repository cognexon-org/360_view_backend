FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install -g npm@latest && npm install
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install -g npm@latest && npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/server.js"]