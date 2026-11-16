import { defineExecutor } from "@dap/contracts";
import type { ActionExecutor, ExecutorId } from "@dap/contracts";

export const GUIDANCE_EXECUTOR_ID = "guidance.read" as ExecutorId;
export const GUIDANCE_TOPICS = ["getting-started", "security-overview"] as const;
export interface GuidanceParams { readonly topicId: string }
export interface Guidance {
  readonly topicId: string;
  readonly title: string;
  readonly steps: readonly string[];
}

// Developer-authored product documentation. No application or tenant records belong here.
const catalog: ReadonlyMap<string, Guidance> = new Map<string, Guidance>([
  ["getting-started", Object.freeze({
    topicId: "getting-started", title: "Тусламжийн заавар авах",
    steps: Object.freeze([
      "Баталгаажсан session-ээр тусламжийн хүсэлт илгээнэ.",
      "getting-started эсвэл security-overview сэдвийг сонгоно.",
      "Систем эрхийг шалгаж, зөвшөөрсөн үед бүртгэлтэй зааврыг буцаана.",
    ]),
  })],
  ["security-overview", Object.freeze({
    topicId: "security-overview", title: "Үйлдлийн аюулгүй ажиллагаа",
    steps: Object.freeze([
      "Хэрэглэгч болон байгууллагыг серверийн баталгаатай session тодорхойлно.",
      "Үйлдэл бүр gateway-ийн бүртгэл, параметр, эрх болон хязгаарын шалгалтаар орно.",
      "Зөвшөөрсөн үйлдлийн audit хадгалагдсаны дараа гүйцэтгэгч ажиллана.",
      "Шалгалт эсвэл шаардлагатай үйлчилгээ доголдвол үйлдэл гүйцэтгэгдэхгүй.",
    ]),
  })],
]);

/** A host supplies a request-local collector; the grant guard runs before publishing anything. */
export function createGuidanceExecutor(publish: (guide: Guidance) => void): ActionExecutor<GuidanceParams, Guidance> {
  return defineExecutor<GuidanceParams, Guidance>({
    id: GUIDANCE_EXECUTOR_ID,
    run: async ({ params }) => {
      const guide = catalog.get(params.topicId);
      if (!guide) return { status: "failure", code: "unknown_topic" };
      publish(guide);
      return { status: "success", value: guide };
    },
  });
}
