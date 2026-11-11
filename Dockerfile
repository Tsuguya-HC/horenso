FROM node:26-alpine@sha256:ce8c3a386c7649c1f9a38d29eb9f6b0c29e70707eb50f208643a75b3f763b60f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:26-alpine@sha256:ce8c3a386c7649c1f9a38d29eb9f6b0c29e70707eb50f208643a75b3f763b60f
RUN addgroup -g 65532 -S nonroot && adduser -u 65532 -S nonroot -G nonroot
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ dist/
USER 65532:65532
EXPOSE 3000
CMD ["node", "dist/index.js"]
