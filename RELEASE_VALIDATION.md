# Release Validation

## Completed during packaging

| Check | Result |
|---|---|
| Python compileall | Passed |
| Vision Python tests | 23 passed |
| TypeScript source parse | 26 files, 0 parse diagnostics |
| Docker Compose YAML parse | Passed; required services present |
| Shell smoke-script syntax | Passed |
| Mode A critical SHA-256 comparison | 6/6 matched baseline |
| Capture Package v2.1 compatibility review | Passed |
| ZIP integrity | Run after final packaging |
| Release SHA-256 manifest | Generated after final cleanup |

## Not executable in the packaging environment

- `npm ci` / complete dependency installation
- `prisma validate` and `prisma generate`
- Full `tsc -p tsconfig.json` semantic typecheck
- Docker image builds and Compose startup
- PostgreSQL schema migration against an existing customer database
- MinIO/Redis integration test
- Physical Android Mode A and Mode B end-to-end test
- Blender final-render execution when Blender is not installed

These must be run in CI or the deployment workstation before production release.

## Recommended commands

```bash
cd services/api-node
npm ci
npx prisma validate
npx prisma generate
npm run build
npm test

cd ../vision-python
python -m pip install -r requirements.txt
pytest -q

cd ../..
cp .env.example .env
docker compose config
docker compose up --build
bash scripts/smoke-test.sh
```
