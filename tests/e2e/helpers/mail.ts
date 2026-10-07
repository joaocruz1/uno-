import { expect, type APIRequestContext } from "@playwright/test";

type Mail = { ID: string; To: Array<{ Address: string }> };
export async function mailLink(request: APIRequestContext, email: string, kind: string) {
  let link = "";
  await expect.poll(async () => {
    const inbox = await (await request.get("http://127.0.0.1:8025/api/v1/messages")).json() as { messages: Mail[] };
    for (const message of inbox.messages.filter(item => item.To.some(to => to.Address === email))) {
      const body = await (await request.get(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json() as { Text: string };
      const candidate = body.Text.match(/http[^\s]+/g)?.find(url => url.includes(kind));
      if (candidate) { link = candidate; return true; }
    }
    return false;
  }, { timeout: 20_000, message: "O e-mail de teste deve chegar ao SMTP local" }).toBe(true);
  return link;
}

