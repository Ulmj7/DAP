# Lab 7 — Ярих тайлбар

## Слайд 1

Энэ танилцуулга нь ai-tuslah төслийн Лаборатори 7-д хийсэн GitHub Actions CI ажлыг тайлбарлана. Workflow код болон хоёр бодит remote run-ийг ашигласан. Ногоон run нь гараар эхлүүлсэн, дараагийн push run улаан болсон. Энэ ялгааг нотолгооны слайдуудад тусад нь харуулна.

## Слайд 2

Lab 7-ийн үндсэн санаа нь checkout, setup, install, test гэсэн дөрвөн алхмыг автоматжуулах юм. Манай төсөл үүн дээр lint, TypeScript, backend build болон DB-тэй шалгалтууд нэмсэн. Хэрэглэгчийн хүсэлтээр зөвхөн main branch дээр ажиллах нөхцөлтэй. Энэ нь эх даалгаврын PR trigger-ээс ялгаатай.

## Слайд 3

on хэсэгт push main болон workflow_dispatch trigger тохируулсан. workflow_dispatch нь GitHub-ийн Run workflow товчийг идэвхжүүлдэг. verify job нь ubuntu-latest дээр ажиллана. if нөхцөлөөр main branch-ийг давхар хязгаарласан. PR trigger одоогоор байхгүй. Энд үзүүлсэн YAML нь бүтэн файлын товчилсон, тайлбарлах хэсэг юм.

## Слайд 4

GitHub runner repository-г татаж Node 22 бэлдээд npm ci ажиллуулна. Кодын дүрэм, төрөл болон build-ийг шалгасны дараа Docker Compose-оор зөвхөн түр PostgreSQL асаана. Migration амжилттай бол тестүүд ажиллана. Cleanup болон тайлангийн алхмууд always нөхцөлтэй тул тест унасан ч DB log болон report хадгалагдаж, түр DB цэвэрлэгдэнэ. Local DB, Minikube-д хандахгүй.

## Слайд 5

Тестийн сан нь Vitest бөгөөд unit, security, conformance, architecture, integration гэсэн таван project тохируулсан. Unit нь тусдаа логик, security нь зөвшөөрөл ба tenant тусгаарлалт, conformance нь adapter-ийн гэрээ, integration нь хэсгүүдийн хамтарсан урсгалыг шалгана. Architecture шалгалт тусдаа болон npm test дотор давхар ажиллаж байгаа нь цааш хялбарчилж болох хэсэг. Docker image build болон Minikube self-healing нь энэ CI-д хараахан ороогүй.

## Слайд 6

Энэ бол бодит амжилттай GitHub Actions run. ID 43919924981, main branch, commit 755b0a7 бөгөөд workflow_dispatch event-ээр гараар эхэлсэн. Нийт job 117 секунд үргэлжилсэн. Dependency 33 секунд, бүх тест 38 секунд байсан. Энэ run нь pipeline бүрэн ажиллаж байгааг нотолно. Push trigger амжилттай ногоон болсон гэж энэ run-ийг тайлбарлахгүй, учир нь event нь manual dispatch юм. Холбоос: https://github.com/Ulmj7/DAP/actions/runs/43919924981

## Слайд 7

Push trigger ажиллаж байгааг энэ run нотолно. ID 43921333197 нь main-ийн 4c86607 commit-оос эхэлсэн, event нь push. Install, lint, TypeScript, BE build, DB, migration, architecture алхмууд амжилттай, харин All existing test suites унасан. Diagnostics, cleanup, report upload амжилттай болсон. Annotation нь exit code 1 гэж мэдээлсэн; яг тестийн шалтгаан энэ аудитад батлагдаагүй. Commit нь тестийг санаатай эвдсэн гэсэн нотолгоо байхгүй тул Lab 7-ийн intentional-failure шаардлагыг хангасан гэж тайлагнахгүй. Холбоос: https://github.com/Ulmj7/DAP/actions/runs/43921333197

## Слайд 8

Lab 7-ийн үндсэн workflow алхмууд болон бодит manual success, push trigger ажилласныг баталсан. Гэхдээ эх даалгавар PR trigger, санаатай тест эвдсэн улаан run болон screenshot шаарддаг. Хэрэглэгч зөвхөн main гэсэн тул PR trigger ороогүй. Улаан push run байгаа ч intentional failure гэж нотлоогүй. Хамгийн сүүлийн push run улаан байгаа тул яг одоо бүх CI асуудалгүй гэж хэлэхгүй. Алдааны log-ийг оношилж зассаны дараа main push-ийн ногоон нотолгоо авах нь дараагийн ажил. Canva холбоосыг энэ орчноос шууд засаж чадаагүй; энэ файл нь Canva-д импортлох editable PPTX хувилбар юм.
