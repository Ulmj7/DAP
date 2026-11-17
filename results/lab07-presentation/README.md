# Lab 7 — GitHub Actions CI слайд

Төсөл: ai-tuslah / Ulmj7/DAP. Хэл: Монгол. Харьцаа: 16:9. Нийт 8 слайд.

## Файлууд

- `Lab07_CI_ai-tuslah.pptx` — текст, shape, diagram-ууд нь засварлах боломжтой PowerPoint.
- `Lab07_CI_ai-tuslah.pdf` — ижил layout-ийн browser-rendered PDF preview, 8 хуудас.
- `preview.html` — бүх слайдын browser preview.
- `slide-01.png` … `slide-08.png` — слайд бүрийн HTML preview screenshot.
- `speaker-notes.md` — слайд бүрт ярих тайлбар; PowerPoint notes дотор мөн оруулсан.
- `sources.json` — repository, workflow, хоёр бодит run болон Canva access-ийн тэмдэглэл.

PPTX нь native PowerPoint text/shape ашигласан; бүхэл слайдыг нэг зураг болгож хийгээгүй.
PDF/PNG нь ижил geometry/content-ийн HTML preview-ээс үүссэн; PowerPoint-ийн өөрийн
renderer-ээр экспортлосон гэж тайлагнахгүй. Canva импортын дараах font/layout-ийг энэ
орчноос шалгах боломжгүй байсан тул импортлосны дараа нэг удаа нягтална.

## Слайдын агуулга

1. Lab 7 ба төслийн CI.
2. Лабораторийн зорилго.
3. Workflow файл ба trigger.
4. Pipeline-ийн ажиллах дараалал.
5. Код, DB, тестийн хамрах хүрээ.
6. Амжилттай manual run — `43919924981`, 117 секунд.
7. Алдаатай main push run — `43921333197`, 104 секунд.
8. Батлагдсан ажил, шаардлагын ялгаа, үлдсэн нотолгоо.

Сүүлийн push run нь `All existing test suites` дээр унасан. Санаатай тест эвдсэн
гэдэг нь батлагдаагүй тул тэгж тайлбарлаагүй. PR trigger нь main-only нөхцөлөөр
ороогүй; Lab 7-ийн бүх эх шаардлага бүрэн хангагдсан гэж слайдад мэдэгдээгүй.
Ногоон run-ийн event `workflow_dispatch`, улаан run-ийн event `push` гэдгийг ялгасан.

## Canva-д оруулах

Хүссэн холбоос: https://canva.link/myykcp15cez56hk

Энэ нь `DAHZyeisw2E` design-ийн editor руу очсон боловч HTTP хүсэлт `403`, browser
нь Cloudflare-ийн `Just a moment...` шалгалт дээр үлдсэн. Энэ session-д Canva edit
connector болон plugin search/suggest tool байгаагүй. Иймээс Canva доторх дизайныг
өөрчлөөгүй, upload/import хийсэн гэж тайлагнахгүй.

Өөрийн нэвтэрсэн desktop browser дээр:

1. Дээрх Canva editor холбоосоо нээнэ.
2. **File → Upload a file** эсвэл **Uploads → Upload files** сонгоно.
3. `Lab07_CI_ai-tuslah.pptx` файлыг сонгож импортлоно.
4. Импортолсон presentation-ийг нээж, шаардлагатай бол хуудсуудыг зорьсон design
   руу copy/paste хийнэ. Font, line break болон footer-ийг нягтална.

Албан ёсны заавар: https://www.canva.com/en_gb/help/powerpoint-import/

Төслийн code, CI workflow, тест болон remote repository-г энэ ажлаар өөрчлөөгүй.
