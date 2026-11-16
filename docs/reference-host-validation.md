# Reference host — хязгаарлагдмал local баталгаажуулалт

Огноо: 2026-11-16. Энэ нь local BE-ийн гараар хийсэн шалгалтын тэмдэглэл.
Production, browser UI, remote CI эсвэл Feature 001 бүрэн дууссан гэсэн нотолгоо биш.

| Шалгалт | Бодит үр дүн |
|---|---|
| `npm run build:host` | Амжилттай; host болон runtime хамаарлууд compile болсон |
| Build-ийн source жагсаалт | Бүх таван build project-д test source болон testkit source 0 |
| Одоо байгаа PostgreSQL Compose service | Healthy; local `127.0.0.1:54329` |
| `npm run db:migrate` | Одоо байгаа 9 migration амжилттай хэрэглэгдсэн |
| `GET /healthz` | `200`, `status=ok` |
| `GET /readyz` | `200`, `status=ready` |
| Эрхтэй session, `getting-started` | `200`, `ALLOWED/ok`, зөв guide буцсан |
| Эрхтэй session, `security-overview` | Эцсийн build дээр `200`, `ALLOWED/ok`, зөв guide буцсан |
| Token-гүй хүсэлт | `401`, `unauthenticated` |
| Permission-гүй session | `403`, `UNAUTHORIZED/not_available`, guide байхгүй |
| Үл мэдэгдэх `topicId` | `400`, `invalid_request` |
| Body-д нэмэлт `tenantId` | `400`, `invalid_request` |
| Tenant-scoped DB audit уншилт | Эрхтэй хүсэлтэд PROPOSED → ALLOWED → EXECUTED (`success`); эрхгүй хүсэлтэд PROPOSED → DENIED, execution event байхгүй |
| Эцсийн сервер зогсоолт | `SIGTERM`-ээр гараар шалгасан процесс цэвэр зогссон |

Startup үеийн Fastify logging deprecation-ийг суулгасан хувилбарын `LogController`
API-аар засаж, эцсийн build-ийг дахин асаан readiness болон хоёр дахь сэдвийг шалгасан.

Local token-уудыг Git-д үл орох `.env.local` файлд permission `600`-тай үүсгэсэн;
token/password-ийг энэ тайланд оруулаагүй. Серверийг шалгалтын дараа зогсоосон,
өмнө нь ажиллаж байсан PostgreSQL service-ийг зогсоогоогүй.

Шинэ автомат тест бичээгүй, одоогийн тест өөрчлөөгүй. Unit/security/integration/
conformance suite, coverage, repository-wide lint/typecheck ажиллуулаагүй.
DB тасалдах, олон concurrent хүсэлт, rate-limit stress, өөр tenant-ийн runtime HTTP
урсгал, production flag startup refusal-ийг энэ гараар хийсэн шалгалтаар туршаагүй.
Автомат integration тест шаарддаг T136 нээлттэй хэвээр; M1/Feature 001-ийг бүхэлд нь
дууссан гэж тэмдэглээгүй.
