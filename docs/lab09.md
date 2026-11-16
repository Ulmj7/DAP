# Лаборатори 9 — Одоо байгаа төслийг Minikube дээр ажиллуулах

Одоо байгаа `ai-tuslah-be:local` image-ийг 3 BE replica болгон ажиллуулна.
Gateway, authorization, rate/replay state, audit нь өмнөх implementation хэвээр.
PostgreSQL нь одоо байгаа Docker container; Minikube дотор шинэ DB үүсгээгүй.
Шинэ API, FE, Swagger, автомат тест, туслах программ нэмээгүй.

## Энэ орчны командууд

Repository root дээр:

```bash
export MINIKUBE_HOME="$PWD/.local-k8s/minikube-state"
export KUBECONFIG="$PWD/.local-k8s/kubeconfig"
export PATH="$PWD/.local-k8s/bin:$PWD/.local-k8s/minikube-state/.minikube/cache/linux/amd64/v1.37.0:$PATH"
```

Энэ нь өмнө суулгасан project-local Minikube/kubectl-ийг ашиглана. Шинэ компьютерт
эдгээр tool-ийг суулгаж cluster бэлдэх шаардлагатай. `.local-k8s/` нь cache, kubeconfig,
key, local runtime credential агуулдаг тул Git ignore-д орсон.

## Асаах ба төлөв харах

Docker daemon ажиллаж байх ёстой. DB-г өмнөх volume-тай нь асаана:

```bash
docker compose -f deploy/compose.yaml up -d --wait postgres
minikube -p ai-tuslah-local start
kubectl get nodes
kubectl -n ai-tuslah-local get deployments,pods,services,jobs
```

Хүлээх үр дүн: node `Ready`, Deployment `3/3`, BE Pod-ууд `1/1 Running`, migration
Job `Complete`. Migration нь өмнө амжилттай дууссан тул энэ засвараар дахин
ажиллуулаагүй. Existing DB-г reset хийхгүй.

## DB endpoint ба manifest дахин хэрэглэх

DB нь `ai-tuslah-local` Docker network-д Minikube node-той холбогдсон.
Cluster-ийн `postgres` Service болон EndpointSlice нь энэ network дахь DB IP рүү заана.
Host дээрх DB port localhost дээрээ хэвээр; public bind нэмээгүй.

DB container дахин үүссэн бол IP-г шалгана:

```bash
docker inspect --format '{{with index .NetworkSettings.Networks "ai-tuslah-local"}}{{.IPAddress}}{{end}}' dap-foundation-postgres-1
```

Хоосон хариу гарвал DB энэ network-д холбогдоогүй байна. Зөвхөн тэр үед:

```bash
docker network connect ai-tuslah-local dap-foundation-postgres-1
```

Дахин IP-г уншиж `deploy/k8s/postgres-endpointslice.yaml` дахь address-ийг тааруулна.
Дараа нь:

```bash
kubectl apply -f deploy/k8s/postgres-service.yaml -f deploy/k8s/postgres-endpointslice.yaml
kubectl apply -f deploy/k8s/deployment.yaml -f deploy/k8s/service.yaml
kubectl -n ai-tuslah-local rollout status deployment/ai-tuslah-be --timeout=120s
```

Одоогийн Deployment болон Job нь `imagePullPolicy: Never` ашиглана. Cluster-ийн
image cache-ийг алдсан бол existing image-ийг дахин load хийнэ:

```bash
minikube -p ai-tuslah-local image load ai-tuslah-be:local
```

## Session / Secret тохиргоо

Startup гацааны шалтгаан нь runtime Secret-ийн `DEV_SESSIONS=[]` байсан. Дор хаяж
нэг хүчинтэй session шаардах одоогийн validation-ийг сулруулаагүй; хүчинтэй session
тохируулсан. Allowlist нь `["getGuidance"]` болсон.

Одоогийн нууц runtime тохиргоо `.local-k8s/runtime.json` дотор permission `600`-тай
хадгалагдана. `NODE_ENV=development`, `DAP_ALLOW_DEV_AUTH=1`, `PORT=3000`, `dap_app`
URL болон `guidance:read` permission-тэй session ашиглана. Owner credential нь app-д
орохгүй, өмнөх migration Secret-дээ үлдэнэ.

Session хугацаа дуусвал энэ protected файл дахь `DEV_SESSIONS`-ийг хүчинтэй local
session-ээр шинэчилж, client-ийн `GUIDANCE_TOKEN`-ийг мөн тааруулна. Session-ийн shape
болон үүсгэх жишээ [BE зааварт](reference-host.md) бий. Нууц утгаа чат/log/screenshot-д
хуулж болохгүй. Файлаа шинэчилсний дараа Secret-д хэрэглэх команд:

```bash
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const config=JSON.parse(readFileSync('.local-k8s/runtime.json','utf8'));
const keys=['NODE_ENV','DAP_ALLOW_DEV_AUTH','PORT','DAP_DATABASE_URL','DAP_GLOBAL_ALLOWLIST','DEV_SESSIONS'];
const data=Object.fromEntries(keys.map(key=>[key,Buffer.from(config[key]).toString('base64')]));
const secret={apiVersion:'v1',kind:'Secret',metadata:{name:'ai-tuslah-runtime',namespace:'ai-tuslah-local'},type:'Opaque',data};
const output=execFileSync('kubectl',['apply','-f','-'],{input:JSON.stringify(secret),encoding:'utf8'});
process.stdout.write(output);
JS
kubectl -n ai-tuslah-local rollout restart deployment/ai-tuslah-be
kubectl -n ai-tuslah-local rollout status deployment/ai-tuslah-be --timeout=120s
```

## API-д хандах

NodePort URL авах:

```bash
minikube -p ai-tuslah-local service ai-tuslah-be -n ai-tuslah-local --url
```

Энэ шалгалтын үед `http://192.168.49.2:30080` байсан. Windows browser-оос bridge IP
хүрэхгүй бол localhost forwarding ашиглаж тухайн terminal-ийг нээлттэй үлдээнэ:

```bash
kubectl -n ai-tuslah-local port-forward service/ai-tuslah-be 3001:3000 --address=127.0.0.1
```

Browser: `http://localhost:3001/readyz` → `{"status":"ready"}`.
Root `/` нь FE биш тул `404` байх нь хэвийн.

Token хэвлэхгүйгээр guidance хүсэлт илгээх:

```bash
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('.local-k8s/runtime.json','utf8'));
const response=await fetch('http://127.0.0.1:3001/guidance',{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.GUIDANCE_TOKEN}`},
  body:JSON.stringify({topicId:'getting-started'}),
});
console.log(response.status,await response.json());
JS
```

## Self-healing дахин ажиглах

```bash
kubectl -n ai-tuslah-local get pods -l app=ai-tuslah-be --field-selector=status.phase=Running -o wide
```

Гурван Ready BE Pod-ийн нэгийн нэрийг авч `kubectl -n ai-tuslah-local delete pod <name>`
ажиллуулна. Дараа нь шинэ нэр/UID-тай Pod үүсээд дахин 3 Ready болсныг ажиглана.
Delete хийхдээ DB, migration эсвэл Deployment-ийг сонгохгүй. Port-forward нь устгасан
Pod-д холбогдсон байсан бол terminal дээрх forwarding-ийг дахин асаана; энэ нь Service-ийн
replica сэргэлтээс тусдаа client connection юм.

Бодитоор хийсэн шалгалт, хоёр screenshot: [results/k8s/README.md](../results/k8s/README.md).
Автомат тест эсвэл stress test нэмээгүй/ажиллуулаагүй.

## Зогсоох

Port-forward terminal дээр `Ctrl+C`. Cluster-ийг хадгалж зогсоох:

```bash
minikube -p ai-tuslah-local stop
```

Энэ нь Docker DB-г зогсоохгүй. DB-г мөн зогсоох шаардлагатай бол тусад нь
`docker compose -f deploy/compose.yaml stop postgres` хэрэглэнэ. DB volume болон
cluster-ийг устгах команд энэ зааварт байхгүй.
