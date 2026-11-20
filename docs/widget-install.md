# ai-tuslah widget суулгах

Widget нь SaaS-ийн веб дээр **AI Help** товч болон нээгдэж хаагддаг цонх харуулна. V1-ийн суулгалтад зөвхөн нийтийн статик JavaScript, CSS ашиглана. AI хариулт болон walkthrough дараагийн хувилбарын хүрээнд орно.

## SaaS хөгжүүлэлтийн багт

1. ai-tuslah багийн өгсөн release-ээс `install.html` доторх `<script>` tag-ийг авна. Тухайн tag-д хувилбартай HTTPS URL болон integrity утга бэлэн байна.
2. Tag-ийг widget харагдах хуудсуудын үндсэн HTML layout-д нэг удаа нэмнэ. Серверээс эхний HTML-д tag гаргавал `defer` нь хуудасны DOM бэлэн болсны дараа script-ийг ажиллуулна.
3. Танай сайт Content Security Policy ашигладаг бол ai-tuslah-ийн asset origin-ийг одоогийн бодлогонд зөвшөөрнө. Script-д `script-src`, stylesheet-д `style-src` үйлчилнэ. `script-src-elem` эсвэл `style-src-elem` тусдаа тодорхойлсон бол харгалзах дүрэмд origin-ийг нэмнэ. Nonce шаарддаг script бодлоготой бол танай серверийн үүсгэдэг nonce-ийг tag-д хэрэглэнэ.
4. Танай орчны release процессоор нийтлээд нэг desktop, нэг mobile viewport дээр шалгана. **AI Help** дээр дарахад цонх нээгдэж, **Close** дарахад хаагдана. Хуудас солих эсвэл дахин ачаалахад нэг товч харагдана.

| Үйлдэл | Алхам |
| --- | --- |
| Шинэчлэх | Шинэ release-ийн `install.html`-аас бүтэн tag-ийг хуулж солино. URL болон integrity утга хамт солигдоно. |
| Буцаах | Өмнөх ажиллаж байсан release-ийн tag-ийг сэргээж нийтэлнэ. |
| Салгах | Layout-аас tag-ийг авч, SaaS-аа дахин нийтэлнэ. |
| Харагдахгүй үед | DevTools дээр `widget.js`, `widget.css`-ийн HTTP төлөв, CSP болон integrity алдааг шалгана. |

## ai-tuslah release хариуцагчид

1. GitHub Actions-ийн `WIDGET_ASSET_ORIGIN` repository variable-д өөрсдийн нийтийн HTTPS asset origin-ийг тохируулна. Утга нь замгүй origin байна. Жишээ нь `https://assets.example.invalid` нь локал build-ийн орлуулагч хаяг юм.
2. `packages/embed/package.json` дахь хувилбарыг шинэчлээд `npm install --package-lock-only` ажиллуулна. Батлагдсан commit-д `widget-vX.Y.Z` tag үүсгэж push хийхэд **Widget** workflow тест, typecheck, build ажиллуулаад ижил нэртэй artifact гаргана.
3. Artifact-ийн `widget/vX.Y.Z/` доторх `widget.css`, дараа нь `widget.js`-ийг ижил замаар asset host-д нийтэлнэ. Зорилтот хувилбарын зам өмнө нь нийтлэгдсэн бол шинэ хувилбар ашиглана. Файлууд HTTPS-ээр, redirect-гүй, `Access-Control-Allow-Origin: *`-тэй байна. JavaScript-д `text/javascript`, CSS-д `text/css` MIME хэрэглэнэ. Хувилбар бүрийн файлуудад `Cache-Control: public, max-age=31536000, immutable` тохируулна.
4. Татсан artifact-ийн `manifest.json`-ийг ашиглан HTTPS, MIME, CORS болон integrity-г шалгана. Дараа нь тусдаа origin дээрх хуудсанд `install.html`-ийн tag-ийг тавьж browser-оор шалгана. Dashboard доторх хуудас солих, mobile viewport, нээж хаах, Network хэсэгт зөвхөн widget-ийн статик файлууд дуудагдаж байгааг шалгана.

```sh
npm run verify:embed -- /path/to/release/manifest.json
```

Түншид artifact доторх `widget-install.md`, хувилбарын `install.html`, шалгагдсан release дугаарыг өгнө. Өмнөх хувилбаруудыг буцаалтад ашиглах боломжтой байлгана. Түншийн production release-ийн дараа тухайн сайтын URL дээр товч болон цонх ажилласныг баталгаажуулна.

Локал build-ийг `npm run build:embed`-ээр гаргахад файл `packages/embed/dist/` дотор үүснэ. `WIDGET_ASSET_ORIGIN` тохируулаагүй локал build-ийн snippet нь жишээ домэйнтэй байна.
