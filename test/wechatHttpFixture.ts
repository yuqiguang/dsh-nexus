/** Actual loopback HTTP; production WeChat URLs are intercepted before reaching the network. */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { WechatUpdates } from '../src/wechat/client.js';

export interface WireReply {
  client_id: string;
  context_token: string;
  to_user_id: string;
  item_list: { type: number; text_item: { text: string } }[];
}

export async function wechatHttpFixture(failAfterFirstSend: boolean) {
  const replies: WireReply[] = [];
  const cursors: string[] = [];
  const queued: (WechatUpdates | string)[] = [];
  const waiting: ServerResponse[] = [];
  const failures: string[] = [];
  let rejectFirstPoll = failAfterFirstSend;
  const respond = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(typeof value === 'string' ? value : JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(request.method, 'POST');
      if (request.url === '/ilink/bot/getconfig') {
        failures.push('optional_typing_configuration_requested_during_startup');
        return respond(response, { ret: -2 });
      }
      if (request.url === '/ilink/bot/sendmessage') {
        replies.push(body.msg);
        return respond(response, { ret: 0 }, failAfterFirstSend && replies.length > 1 ? 503 : 200);
      }
      assert.equal(request.url, '/ilink/bot/getupdates');
      cursors.push(body.get_updates_buf);
      if (rejectFirstPoll) {
        rejectFirstPoll = false;
        return respond(response, { ret: -1 });
      }
      const next = queued.shift();
      if (next) return respond(response, next);
      if (cursors.length === 1) return respond(response, { msgs: [], get_updates_buf: body.get_updates_buf });
      waiting.push(response);
      response.once('close', () => {
        const index = waiting.indexOf(response);
        if (index !== -1) waiting.splice(index, 1);
      });
    })().catch(() => {
      failures.push('invalid_local_http_request');
      if (!response.destroyed) respond(response, {}, 500);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
    return fetch(new URL(url.pathname, origin), init);
  };
  return {
    replies, cursors, failures, fetchImpl,
    enqueue(update: WechatUpdates | string) {
      const response = waiting.shift();
      if (response) respond(response, update);
      else queued.push(update);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
