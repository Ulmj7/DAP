# Main branch-ийн CI

Workflow: `.github/workflows/ci.yml`.

Эхний зорилго нь одоо байгаа кодын CI-г GitHub дээр амжилттай ажиллуулж батлах.
Энэ шатанд зориуд алдаатай commit/run үүсгэхгүй, шинэ unit test нэмэхгүй.

## Хэзээ ажиллах вэ?

- `main` руу push хийхэд автоматаар.
- GitHub → Actions → `ci` → Run workflow → `main` сонгоход.
- Pull Request болон өөр branch-ийн push дээр ажиллахгүй. Гараар өөр branch
  сонгосон ч job main-only guard-аар алгасагдана.

Lab 7-ийн эх шаардлага push болон PR trigger хүсдэг боловч хэрэглэгчийн main-only
хязгаарыг дагасан. PR trigger-ийн шалгалтыг гүйцэтгэсэн гэж тайлагнахгүй.

## Шалгах дараалал

Checkout → Node.js 22 → npm ci → lint → TypeScript → host build → түр PostgreSQL
→ migration → architecture tests → одоо байгаа бүх Vitest suite.

PostgreSQL нь GitHub runner дээр тухайн run/attempt-д зориулсан Compose project
дотор үүснэ. Cleanup нь зөвхөн энэ project-ийн түр volume-ийг устгана; local
Docker PostgreSQL болон Minikube-д хандахгүй.

`npm test` нь unit, architecture, security, conformance, integration project-уудыг
ажиллуулна. Test report болон DB diagnostics нь Actions artifact-д 7 хоног хадгалагдана.
Нэг job 20 минутын хязгаартай. Шинэ main run эхэлбэл өмнөх ижил ref-ийн run цуцлагдана.

## GitHub дээр эхний run авах

1. Энэ орчинд repository-д push эрхтэй GitHub account-аар Git credential manager
   эсвэл GitHub CLI (`gh auth login`) ашиглан нэвтэрнэ. Token/password-ийг чатанд
   эсвэл repository-д оруулахгүй.
2. Workflow-ийн өөрчлөлтийг review хийж `main`-д commit/push хийнэ.
3. `https://github.com/Ulmj7/DAP/actions` → `ci` → шинэ run →
   `Code, build and PostgreSQL tests` job-ийг нээнэ.
4. Унасан бол хамгийн эхний failed step-ийн log болон `ci-reports-*` artifact-ийг
   ашиглаж шалтгааныг засна. Бүх step амжилттай болсон remote run нь эхний ногоон CI
   нотолгоо болно.

`workflow_dispatch` нь GitHub-ийн default branch дахь workflow-д орсны дараа
Run workflow товч харагдана.

## Энэ шатанд хамаарахгүй зүйл

Docker image/Compose API, Minikube/self-healing автомат job-ууд, Lab 10-ийн 5 шинэ
unit test болон улаан → ногоон туршилтыг үндсэн CI ногоон болсны дараагийн шатанд
нэмнэ. Энэ workflow production эсвэл local cluster рүү deploy хийхгүй.

## Одоогийн баталгаажуулалт

Local lint, TypeScript check, host build, workflow YAML болон shell syntax шалгалт
амжилттай. Local дээр том test suite ажиллуулаагүй.
Remote repository-д `ci` workflow active боловч шалгасан үед run 0 байсан.
Remote push authentication байхгүй (`could not read Username`), тиймээс шинэ
workflow-ийн remote success, screenshot болон Lab 7/10 бүрэн гүйцэтгэл одоогоор
баталгаажаагүй.
