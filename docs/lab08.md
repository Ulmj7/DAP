# Лаборатори 8 — Төслийн BE-г Docker-т ажиллуулах

Шинэ demo сервер нэмээгүй. Одоо байгаа Fastify BE, security gateway, PostgreSQL
adapter болон migration runner-ийг нэг image-ээр ажиллуулна. Swagger дараагийн ажил.

## 1. Шаардлага ба local тохиргоо

Repository root дээр Docker daemon, Docker Compose v2, Node.js 22+ ашиглана.
Docker Desktop/WSL integration идэвхтэй байх ёстой.

```bash
docker --version
docker info
docker compose version
node scripts/configure-docker.mjs
```

Сүүлийн команд өмнөх [BE зааврын](reference-host.md) `.env.local`-оос session-уудыг
авч `.env.docker.local`-ийг permission `600`-тай үүсгэнэ. Байгаа файл дарж бичихгүй.
Session хугацаа дууссан бол өмнөх заавраар шинэчилж, Docker тохиргооны session-уудыг
мөн шинэчилнэ. Бүх credential local ignored файлд байна; screenshot/log-д гаргахгүй.

`.env.docker.example` нь тохиргооны загвар. Анхдагчаар app host port `3000`, DB host
port `54329`. Container дотор DB хаяг `postgres:5432` байна. Өмнөх PostgreSQL volume
өөр password-тай бол түүнийг өөрчлөхгүй, URL/password-уудаа түүнд тааруулна.
Custom owner password ашиглавал configure командад `DAP_OWNER_PASSWORD` эсвэл
`DAP_DOCKER_MIGRATE_DATABASE_URL` environment-аар өгнө. Бэлэн volume-ийн password-ийг
Compose environment өөрчлөхөд автоматаар солихгүй.

## 2. Image бүтээх

```bash
mkdir -p results/lab08
set -o pipefail
docker build --progress=plain -t ai-tuslah:lab08 . 2>&1 | tee results/lab08/build-initial.txt
```

Dockerfile-ийн stage-ууд:

1. `manifests`: npm workspace manifest болон lockfile-ууд.
2. `build`: `npm ci` → source/config хуулах → `npm run build:host`.
3. `production-deps`: `npm ci --omit=dev`.
4. `runtime`: production dependency, compile болсон BE/package, migration SQL/runner.

Runtime нь non-root `node` хэрэглэгчтэй. CMD нь compiled BE-г шууд ажиллуулдаг тул
`docker stop`-ийн SIGTERM сервер болон DB pool-д хүрнэ. `NODE_ENV=production` гэж
тохируулахгүй: одоогийн host development-only authentication ашиглаж байна.
Build нь тест compile/run хийхгүй. `.dockerignore` нь зөвхөн build-д хэрэгтэй
файлуудыг зөвшөөрч, local secret болон evidence файлуудыг оруулахгүй.

## 3. Дан container ажиллуулах

Эхлээд DB, migration-ийг бэлдэнэ:

```bash
docker compose --env-file .env.docker.local -f deploy/compose.yaml up -d --wait postgres
docker compose --env-file .env.docker.local -f deploy/compose.yaml run --rm migrate
```

Доорх команд Compose-ийн app тохиргоог credential хэвлэхгүйгээр уншиж, **docker run**
дуудна. App-ийн whitelist environment л дамжина; owner DB URL дамжихгүй.

```bash
node --input-type=module <<'JS'
import { execFileSync, spawnSync } from 'node:child_process';
const args = ['compose', '--env-file', '.env.docker.local', '-f', 'deploy/compose.yaml'];
const config = JSON.parse(execFileSync('docker', [...args, 'config', '--format', 'json'], {encoding: 'utf8'}));
const app = config.services.app;
const environment = Object.fromEntries(Object.entries(app.environment).map(([key, value]) => [key, String(value)]));
const publish = app.ports[0];
const run = ['run', '-d', '--init', '--name', 'ai-tuslah-lab08', '--network', `${config.name}_default`,
  '-p', `${publish.host_ip}:${publish.published}:${publish.target}`];
for (const key of Object.keys(environment)) run.push('--env', key);
run.push(app.image);
const result = spawnSync('docker', run, {env: {...process.env, ...environment}, stdio: 'inherit'});
process.exitCode = result.status ?? 1;
JS
```

Local BE аль хэдийн host port `3000` ашиглаж байвал түүнийг зогсоох эсвэл
`.env.docker.local` дахь `DAP_HOST_PORT`-ийг өөрчилнө.

```bash
docker logs ai-tuslah-lab08
curl -i http://localhost:3000/readyz
```

Browser дээр `http://localhost:3000/readyz` нээнэ. `{"status":"ready"}` хариу нь
контейнер доторх бодит BE болон DB холболт ажилласныг харуулна. Root `/` нь FE биш,
`404` хариулах нь хэвийн. `/guidance` хүсэлтийн жишээ өмнөх BE зааварт бий.

## 4. Compose-оор хамтад нь ажиллуулах

Дан app container-ийн портыг чөлөөлөөд:

```bash
docker stop ai-tuslah-lab08
docker rm ai-tuslah-lab08
docker compose --env-file .env.docker.local -f deploy/compose.yaml up -d --build --wait
docker compose --env-file .env.docker.local -f deploy/compose.yaml ps -a
docker compose --env-file .env.docker.local -f deploy/compose.yaml logs --no-color app migrate
```

Дараалал: **postgres healthy → migrate exit 0 → app healthy**.
`migrate` нь нэг удаагийн процесс учраас `Exited (0)` байдалтай байх нь зөв.
Migration алдаа гарвал app эхлэхгүй. App readiness нь `/readyz` ашиглана.
App-д `dap_app` URL болон session/allowlist л дамжуулна; `dap_owner` URL зөвхөн migrate-д байна.
Healthcheck нь автомат тестийн suite биш, контейнерийн ажиллагааны probe юм.

Одоо байгаа `docker compose -f deploy/compose.yaml up -d --wait postgres` команд болон
CI-ийн зөвхөн DB асаах урсгалд session шаардахгүй; app-ийг асаахад хүчинтэй session хэрэгтэй.

## 5. Layer caching-ийн нотолгоо

Анхны image бүтээсний дараа `getting-started` зааврын нэг өгүүлбэрийг илүү тодорхой
API ашиглах заавраар сайжруулж, **source өөрчлөгдсөн** төлөвөөс дахин build хийнэ:

```bash
set -o pipefail
docker build --progress=plain -t ai-tuslah:lab08 . 2>&1 | tee results/lab08/build-cached.txt
docker compose --env-file .env.docker.local -f deploy/compose.yaml up -d --wait
```

`--no-cache` хэрэглэхгүй. Log дээр:

- `RUN npm ci --no-audit --no-fund` → `CACHED`.
- `RUN npm ci --omit=dev --no-audit --no-fund` → `CACHED`.
- Өөрчилсөн action source-ийн `COPY`, `RUN npm run build:host` дахин ажиллана.

API хүсэлтээр шинэ өгүүлбэр буцаж байгааг шалгана. Дараа нь өөрөө дахин турших бол
өөр нэг жижиг, утгатай source өөрчлөлт хийнэ. Файл өөрчлөхгүй давтан build хийх нь
source өөрчлөгдсөн ч dependency cache хадгалагдахыг дангаараа нотлохгүй.

## 6. Хүлээлгэн өгөх материал

`results/lab08/` дотор анхны/давтан build output, container/Compose төлөв, log,
цөөн API хүсэлтийн үр дүн, screenshot болон validation тайлан хадгална.

- `01-readiness.png`: browser дахь бодит `/readyz` хариу.
- `02-build-cache.png`: хадгалсан бодит build output-ийг browser дээр харуулсан screenshot.
  Энэ нь terminal цонхны screenshot биш; эх terminal output нь `.txt` файлаар дагалдана.
- Dockerfile болон Compose тохиргоо repository-д байна.

Энэ ажлаар автомат тест бичихгүй, одоогийн тестийг өөрчлөхгүй; test suite,
coverage, repo-wide lint/typecheck ажиллуулахгүй. Docker image build болон цөөн API
хүсэлтээр ажиллагааг батална. Local container-ийн нотолгоо нь production/CI/Teams
submission нотолгоо биш.

## Зогсоох

```bash
docker compose --env-file .env.docker.local -f deploy/compose.yaml stop app
```

DB-г мөн зогсоох шаардлагатай үед `stop postgres` хэрэглэнэ. Энэ зааварт volume устгах
команд байхгүй; одоо байгаа өгөгдлийг хадгална.
