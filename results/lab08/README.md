# Лаборатори 8 — Local container-ийн нотолгоо

Огноо: 2026-11-16. Одоо байгаа төслийн BE-г Docker-т ажиллуулсан.
Энэ нь production deployment, remote CI эсвэл Teams submission нотолгоо биш.

## Шаардлага ба үр дүн

| Лабораторийн шаардлага | Бодитоор хийсэн ажил | Нотолгоо |
|---|---|---|
| Docker шалгах | Docker 28.5.1, Compose v2.40.2 | `environment.txt` |
| Жишиг апп | Одоо байгаа Fastify BE, gateway болон PostgreSQL; шинэ demo сервер нэмээгүй | `standalone-http.json`, `compose-http.json` |
| Dockerfile | Node 22 multi-stage; manifest → npm ci → source → host build; non-root runtime | Repository root-ийн `Dockerfile`, `runtime-image.json` |
| Image бүтээх | `ai-tuslah:lab08` image амжилттай үүссэн | `build-initial.txt`, `image-initial.json` |
| Дан container | `docker run`-аар Compose network-д холбон ажиллуулсан | `standalone-container.txt`, `standalone-http.json` |
| Log харах | Дан container болон Compose app-ийн startup/request log хадгалсан | `standalone-app.log`, `compose-app.log` |
| Compose | PostgreSQL healthy → migration exit 0 → app healthy | `compose-start.txt`, `compose-status.txt`, `compose-build.txt` |
| Layer caching | Action source өөрчилсний дараа dependency layer-ууд CACHED; host build дахин ажилласан | `build-cached.txt`, `02-build-cache.png` |
| Browser screenshot | Бодит BE-ийн `/readyz` хариу | `01-readiness.png` |

## Кодын жижиг өөрчлөлт

`packages/actions/src/guidance.ts` дахь `getting-started` сэдвийн эхний өгүүлбэрийг:

```text
Баталгаажсан session-ээр тусламжийн хүсэлт илгээнэ.
```

гэсэн ерөнхий тайлбараас:

```text
POST /guidance руу Authorization: Bearer header болон topicId бүхий JSON хүсэлт илгээнэ.
```

гэж илүү тодорхой болгосон. `standalone-http.json` хуучин, `compose-http.json`
шинэ текстийг харуулна. Action-ийн input schema болон security policy өөрчлөгдөөгүй.

Анхны image: `153e493bbdf0dfde161d574edb94b8bbedc245f52aec6576e9c74134c2ace4f3`.
Source өөрчлөлтийн дараах `docker build` image:
`2c7e1a481bb60e409a0d490fc191c7245e310daf75066680fccd7f22eeea0a7c`.
Бүрэн metadata нь `image-initial.json`, `image-cached.json` дотор байна.

Дараа нь баримтжуулсан `docker compose ... up -d --build --wait` командыг мөн
ажиллуулсан; бүх build layer cache ашиглаж, app дахин healthy болсон. Энэ эцсийн
Compose build-ийн image ID нь `9cf7a3379990f9feed9e6981cfb065833691ae3f7ac36ceaafa2c76a7f05828e`;
эх log нь `compose-build.txt`, ID-ийн тэмдэглэл нь `image-compose.json`.

Давтан build дээр:

- Build dependency install: `CACHED`.
- Runtime dependency install: `CACHED`.
- Action source COPY: дахин ажилласан.
- `npm run build:host`: дахин ажиллаж, 4.8 секундэд дууссан.

Build context анх 543.68 KB, давтан build-ийн илгээсэн өөрчлөлт 10.60 KB байсан.
Эдгээр нь хоёр log-ийн бодит `transferring context` утга; image хэмжээ биш.

## API ба screenshot

Дан container болон Compose дээр `/healthz`, `/readyz`, зөвшөөрөгдсөн `/guidance`
хүсэлт `200` буцаасан. Token-ийг нотолгоонд хадгалаагүй.

- `01-readiness.png` нь headless Chromium-оор `http://127.0.0.1:3000/readyz`
  хуудсыг нээсэн browser viewport screenshot; хариу нь `{"status":"ready"}`.
- `02-build-cache.png` нь хадгалсан бодит log-ийн тасалбаруудыг `build-output.html`
  дээр харуулсан browser screenshot. Энэ нь terminal цонхны screenshot биш.
  Бүтэн эх гаралт `build-cached.txt`, өөрчлөлтгүй тасалбар нь `build-cache-excerpt.txt`.

## Шалгалтын хүрээ ба ажиллах төлөв

Шинэ автомат тест бичээгүй, одоогийн тест өөрчлөөгүй. Test suite, coverage болон
repo-wide lint/typecheck ажиллуулаагүй. Зөвхөн image build, container health,
цөөн HTTP хүсэлт болон runtime image-ийн жижиг файлын шалгалт хийсэн.

Өмнө ажиллаж байсан PostgreSQL container/volume-ийг хадгалсан. Дан app container-ийг
Compose-д шилжихдээ зогсоож устгасан. Эцсийн Compose app нь host-ийн
`127.0.0.1:3000` дээр ажиллана; migration container `Exited (0)` байх нь зөв.
App development-only session ашиглана; session-уудын хугацаа дуусвал local session
тохиргоогоо шинэчилж app-ийг дахин үүсгэнэ.

Асаах/зогсоох бүрэн заавар: [docs/lab08.md](../../docs/lab08.md).
