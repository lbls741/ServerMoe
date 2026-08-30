// 可编排的 iLink Bot API mock 服务（Hono + Bun.serve 临时端口），驱动 M2 集成测试。
import { Hono } from "hono";
import type { QrStatusResp, SendMessageReq, WeixinMessage } from "../../src/channels/wechat/ilink/types.ts";

export interface UpdateStep {
  msgs?: WeixinMessage[];
  ret?: number;
  errcode?: number;
  errmsg?: string;
  newBuf?: string;
}
export interface SendStep {
  ret?: number;
  errmsg?: string;
}
export interface MockScenario {
  qrStatus: QrStatusResp[]; // 每次状态轮询消费一个；耗尽后重复最后一个
  updates: UpdateStep[]; // 每次收信轮询消费一个；耗尽后返回空列表
  sends: SendStep[]; // 每次发送消费一个；耗尽后默认 ret=0
}
export interface MockRecord {
  qrPolls: string[];
  updateBufs: string[];
  sends: SendMessageReq[];
  notifyStarts: number;
  notifyStops: number;
}
export interface MockIlink {
  port: number;
  scenario: MockScenario;
  record: MockRecord;
  stop(): void;
}

export function startMockIlink(factory: (port: number) => MockScenario): MockIlink {
  const record: MockRecord = { qrPolls: [], updateBufs: [], sends: [], notifyStarts: 0, notifyStops: 0 };
  // 场景需在拿到端口后才能构造（confirmed 响应要回填 baseurl），故只能声明后再赋值
  // eslint-disable-next-line prefer-const
  let scenario: MockScenario;
  let lastBuf = "";
  const app = new Hono();

  app.post("/ilink/bot/get_bot_qrcode", (c) =>
    c.json({ qrcode: `qr-${record.qrPolls.length}`, qrcode_img_content: "https://qr.example/scan" }),
  );

  app.get("/ilink/bot/get_qrcode_status", (c) => {
    record.qrPolls.push(c.req.query("verify_code") ?? "");
    const step = scenario.qrStatus.shift() ?? scenario.qrStatus[scenario.qrStatus.length - 1] ?? { status: "wait" as const };
    return c.json(step);
  });

  app.post("/ilink/bot/getupdates", async (c) => {
    const body = (await c.req.json()) as { get_updates_buf?: string };
    record.updateBufs.push(body.get_updates_buf ?? "");
    if (scenario.updates.length > 0) {
      const step = scenario.updates.shift()!;
      if (step.newBuf !== undefined) lastBuf = step.newBuf;
      if ((step.ret ?? 0) !== 0 || (step.errcode ?? 0) !== 0) {
        return c.json({ ret: step.ret ?? 0, errcode: step.errcode, errmsg: step.errmsg, msgs: [] });
      }
      return c.json({ ret: 0, msgs: step.msgs ?? [], get_updates_buf: step.newBuf ?? lastBuf });
    }
    await new Promise((r) => setTimeout(r, 30)); // 空轮询防热循环
    return c.json({ ret: 0, msgs: [], get_updates_buf: lastBuf });
  });

  app.post("/ilink/bot/sendmessage", async (c) => {
    const body = (await c.req.json()) as SendMessageReq;
    record.sends.push(body);
    const step = scenario.sends.shift() ?? { ret: 0 };
    return c.json({ ret: step.ret ?? 0, errmsg: step.errmsg });
  });

  app.post("/ilink/bot/msg/notifystart", (c) => {
    record.notifyStarts += 1;
    return c.json({ ret: 0 });
  });
  app.post("/ilink/bot/msg/notifystop", (c) => {
    record.notifyStops += 1;
    return c.json({ ret: 0 });
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const port = server.port ?? 0;
  scenario = factory(port);
  return {
    port,
    scenario,
    record,
    stop: () => server.stop(true),
  };
}
