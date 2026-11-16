# Reference host — local BE ажиллуулах

Энэ нь төслийн бодит gateway болон PostgreSQL adapter-уудыг холбосон development BE юм.
Одоогоор HTTP API ажиллана; browser UI, бодит LLM, RAG, confirmation байхгүй.
`getGuidance` нь developer-ийн бичсэн хоёр сэдвийн нийтлэг бүтээгдэхүүний зааврыг буцаана.

BE-г контейнерт ажиллуулах бол [Лаборатори 8 / Docker заавар](lab08.md)-ыг ашиглана.

## 1. Dependency ба PostgreSQL

Repository root дээр Node.js 22+, npm, ажиллаж буй Docker daemon ашиглана:

```bash
npm ci
docker compose -f deploy/compose.yaml up -d --wait postgres
```

Одоо байгаа migration-уудыг local Compose-ийн default owner credential-аар ажиллуулна:

```bash
DAP_MIGRATE_DATABASE_URL='postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54329/dap' npm run db:migrate
```

Өмнөх volume өөр password/port ашигладаг бол өөрийн connection URL-ийг тохируулна.
BE өөрөө migration ажиллуулахгүй; runtime нь зөвхөн `dap_app` role ашиглана.

## 2. Local session үүсгэх

Доорх командыг root дээр нэг удаа ажиллуулна. `.env.local`-ийг permission `600`-тай
үүсгэж, хоёр random token хадгална. Байгаа файлыг дарж бичихгүй, token-ийг хэвлэхгүй.
Session-ууд 8 цагийн дараа дуусна. Дууссан үед `.env.local` дахь session-ийн
хугацаа/token-ийг шинэчилж, серверээ дахин асаана.

```bash
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const tenantId = randomUUID();
const authenticatedAt = new Date().toISOString();
const validUntil = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
const token = randomBytes(32).toString('hex');
const deniedToken = randomBytes(32).toString('hex');
const sessions = [
  { token, userId: 'local-reader', tenantId, sessionId: randomUUID(), authenticatedAt, validUntil, permissions: ['guidance:read'] },
  { token: deniedToken, userId: 'local-no-permission', tenantId, sessionId: randomUUID(), authenticatedAt, validUntil, permissions: [] },
];
const template = readFileSync('.env.example', 'utf8');
const configured = template.replace("DEV_SESSIONS='[]'", `DEV_SESSIONS='${JSON.stringify(sessions)}'`);
writeFileSync('.env.local', configured + `\nGUIDANCE_TOKEN=${token}\nDENIED_TOKEN=${deniedToken}\n`, { mode: 0o600, flag: 'wx' });
console.log('Created .env.local (tokens hidden).');
JS
```

Тохиргооны гол утгууд:

| Variable | Үүрэг |
|---|---|
| `PORT` | Анхдагч `3000`; bind address нь `0.0.0.0` |
| `DAP_DATABASE_URL` | `dap_app` connection URL |
| `DAP_ALLOW_DEV_AUTH` | Заавал `1`; `NODE_ENV=production` үед эхлэхгүй |
| `DEV_SESSIONS` | Token, user, tenant, session, хугацаа, permission бүхий JSON массив |
| `DAP_GLOBAL_ALLOWLIST` | JSON массив; анхдагч `[]`; энэ host зөвхөн `getGuidance` мэднэ |

`GUIDANCE_TOKEN`, `DENIED_TOKEN` нь зөвхөн доорх curl жишээнүүдэд ашиглах client утгууд.
User/tenant/session identifier-ууд хоосон биш, хяналтын тэмдэгтгүй; tenant нь lowercase,
nil биш UUID байна. Token нь 32–256 тэмдэгттэй, зөвхөн үсэг, тоо, `_`, `-` агуулна.
Нэг tenant/user/session-д нэг token тохируулна. Permission жагсаалт хоосон эсвэл
`["guidance:read"]` байна. Тохиргоо өөрчилсний дараа restart хийнэ.

## 3. Build ба асаах

```bash
npm run build:host
npm run start:host
```

Build нь host болон runtime хамаарлуудыг compile хийнэ; test source, testkit-ийг оруулахгүй.
Start нь `.env.local`-ийг байвал уншина; өмнө export хийсэн environment илүү давуу эрхтэй.
`Ctrl+C` нь HTTP сервер болон DB pool-ийг хаана. DB доголдсон ч процессын health
ажиллана; readiness болон guidance нь `503` буцаана.

## 4. HTTP ашиглах

Өөр terminal дээр repository root-оос:

```bash
curl -i http://localhost:3000/healthz
curl -i http://localhost:3000/readyz
curl -i http://localhost:3000/guidance \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(node --env-file=.env.local -p 'process.env.GUIDANCE_TOKEN')" \
  --data '{"topicId":"getting-started"}'
```

`POST /guidance` зөвхөн `topicId` авна: `getting-started`, `security-overview`.
Action нэр, raw proposal, user, tenant, permission, request/call ID хүлээн авахгүй.
Сервер metadata болон proposal-ийг өөрөө үүсгэж, gateway-д дамжуулна.

Амжилттай хариу:

```json
{
  "feedback": { "outcome": "ALLOWED", "category": "ok" },
  "guide": {
    "topicId": "getting-started",
    "title": "Тусламжийн заавар авах",
    "steps": ["..."]
  }
}
```

| HTTP | Утга |
|---|---|
| `200` | Gateway зөвшөөрч, executor амжилттай ажилласан |
| `400` | Body буруу, нэмэлт талбартай, эсвэл сэдэв бүртгэлгүй |
| `401` | Token байхгүй, буруу эсвэл session хугацаа дууссан |
| `403` | Permission, allowlist, tenant policy эсвэл gateway-ийн бусад хязгаар татгалзсан |
| `503` | DB/security state/audit доголдсон эсвэл execution амжилтгүй |

Татгалзсан хариунд `guide`, internal reason, stack trace, credential оруулахгүй.
Бүх request body дээд тал нь 1024 byte. `/healthz`, `/readyz` нь нэвтрэлт шаардахгүй.
Readiness нь DB role, шаардлагатай хүснэгтүүдийн RLS болон эрхийг шалгана;
audit event бичихгүй. Actual audit write амжилттай болсны дараа л executor ажиллана.

Урсгал:

```text
POST /guidance → session/context → server-created proposal → gateway
  → PostgreSQL audit → grant-checked executor → request-local guide → HTTP response
```

Gateway-ийн `PlannerFeedback` contract өөрчлөгдөөгүй. Guide нь зөвхөн host-ийн
хүсэлтэд тусгаарласан collector-оор дамжина; planner-д өгөх feedback дотор байхгүй.
Унших API тул client retry бүр шинэ хүсэлт; client idempotency contract байхгүй.

## Баталгаажуулалтын хүрээ

Энэ ажлаар шинэ тест бичихгүй, одоогийн тестүүдийг өөрчлөхгүй, том suite ажиллуулахгүй.
Host build, цөөн HTTP хүсэлт, tenant-scoped audit уншилтаар л шалгана.
Автомат integration тест шаардсан T136 болон бүх Feature 001-ийг дууссан гэж үзэхгүй.
Dockerfile, app Compose service, FE, LLM/RAG, confirmation endpoint энэ өөрчлөлтийн хүрээнээс гадуур.
