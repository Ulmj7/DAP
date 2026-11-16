# Лаборатори 9 — Бодит local гүйцэтгэл

Огноо: 2026-11-17 (Asia/Ulaanbaatar). Profile/namespace: `ai-tuslah-local`.
Одоо байгаа `ai-tuslah-be:local` image болон Docker PostgreSQL ашигласан.
BE source, API, Dockerfile өөрчлөөгүй; image дахин build хийгээгүй.

## Шаардлага ба нотолгоо

| Шаардлага | Үр дүн | Нотолгоо |
|---|---|---|
| Minikube cluster | Өмнө бэлдсэн Ready cluster-ийг ашигласан | `deployment-ready.txt`, `final-status.txt` |
| Deployment, 3 replica | `3/3 Ready`, `3 Available` | `deployment-ready.txt`, `01-deployment.png` |
| Service | NodePort `30080`; 3 ready endpoint | `ready-endpoints-before.json`, `ready-endpoints-after.json` |
| Бодит апп ажиллах | Service-ээр health/readiness/guidance `200` | `service-http-before.json` |
| DB-тай бүтэн урсгал | Нэг request ID-тай PROPOSED → ALLOWED → EXECUTED (`success`) | `audit.json` |
| Self-healing | Нэг Ready Pod устгахад шинэ UID-тай Pod нөхөгдөж дахин 3 Ready болсон | `self-healing.txt`, `self-healing.json`, `02-self-healing.png` |
| Сэргэлтийн дараах ажиллагаа | Guidance `200`, ready endpoint 3 | `service-http-after.json`, `ready-endpoints-after.json` |

Үндсэн YAML deliverable:

- [deployment.yaml](../../deploy/k8s/deployment.yaml)
- [service.yaml](../../deploy/k8s/service.yaml)

Үндсэн хоёр screenshot:

- [01-deployment.png](01-deployment.png)
- [02-self-healing.png](02-self-healing.png)

Эдгээр нь хадгалсан **бодит kubectl output**-ийг browser log viewer дээр харуулсан
screenshot; terminal цонхны screenshot биш. Эх `.txt` гаралт болон viewer-ийн `.html`
файлууд хамт байна. Нэмэлт `03-readiness.png` нь localhost port-forward-оор бодит
`/readyz` хуудсыг browser-оор нээсэн screenshot.

## Зассан гацаа

Эхэндээ гурван BE Pod `CrashLoopBackOff`, Deployment `0/3` байсан
(`before-status.txt`). Runtime Secret-ийн `DEV_SESSIONS=[]` нь одоогийн startup
validation-д тэнцэхгүй байв. Мөн allowlist хоосон байсан.

- Хүчинтэй local session-ийг дахин ашиглаж, runtime Secret-д тохируулсан.
- Allowlist-ийг `["getGuidance"]` болгосон; кодын хамгаалалтыг сулруулаагүй.
- Хадгалсан DB EndpointSlice address-ийг live shared network-ийн `192.168.49.3`
  утгатай тааруулсан. PostgreSQL host bind-ийг өөрчлөөгүй, шинэ DB үүсгээгүй.
- Existing manifest-уудыг apply хийж, Deployment rollout restart хийсэн.
- `.local-k8s/`-ийг Git ignore-д нэмсэн; credential, kubeconfig, cache-ийг устгаагүй.

Нууц утгагүй тохиргооны хураангуй: `configuration-summary.json`.
Runtime credential нь зөвхөн Git-д орохгүй `.local-k8s/runtime.json` файлд permission
`600`-тай байна. Дахин ашигласан session 2026-11-17 **02:17** Улаанбаатарын цагаар
дуусна. Дараа нь session тохиргоог шинэчилж Secret-д хэрэглэнэ; заавар доорх холбоост бий.

Migration Job өмнө `Complete (1/1)` болсон тул энэ ажлаар дахин ажиллуулаагүй.
Одоо байгаа DB өгөгдөл, volume-ийг хадгалсан; зөвхөн зөвшөөрөгдсөн API хүсэлтийн
ердийн audit/rate/replay state нэмэгдсэн.

## Self-healing-ийн тодорхой үр дүн

Устгасан Pod:

```text
ai-tuslah-be-59f44bf7bf-h5wz2
UID: 5e6e8a13-8a1c-450b-9f0d-5349aa5322b8
```

Автоматаар нөхөгдсөн Pod:

```text
ai-tuslah-be-59f44bf7bf-c2wqb
UID: 7dd4cd53-0e3c-458f-8cbc-7757fc98fcdf
```

Бусад хоёр Ready Pod-ийн UID хэвээр үлдсэн. Энэ нь Pod replacement-ийн нотолгоо;
node/DB өндөр хүртээмж эсвэл тасралтгүй client connection-ийн баталгаа биш.

## Хүрээ ба одоогийн хандалт

Автомат тест, stress test, repo-wide lint/typecheck ажиллуулаагүй. Шинэ API, FE,
Swagger, deployment helper программ нэмээгүй. Зөвхөн configuration, manifest,
гараар хийсэн лабораторийн шалгалт болон баримтжуулалт хийсэн.

Service: `http://192.168.49.2:30080`.
Local forwarding: `http://localhost:3001/readyz` — forwarding процесс ажиллаж байх үед.
Cluster болон DB-г ажиллаж байгаагаар үлдээсэн. Зогсоох/дахин асаах, session болон
DB endpoint шинэчлэх заавар: [docs/lab09.md](../../docs/lab09.md).

Энэ нь local лабораторийн гүйцэтгэл; remote CI, production deployment эсвэл Teams
submission хийгдсэн гэсэн нотолгоо биш.
