import { createServer } from 'node:http';
import {
  CHAINS,
  addAddress,
  beginTrace,
  cancelSession,
  continueTrace,
  previewTx,
  removeNode,
} from './engine.js';
import { readSafeOwners } from './evm.js';
import { lookupLabels } from './labels.js';

const PORT = Number(process.env.PORT || 8787);

function allowOrigin(req, res) {
  const origin = req.headers.origin || '';
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('请求太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 无法解析'));
      }
    });
    req.on('error', reject);
  });
}

function openSse(req, res) {
  allowOrigin(req, res);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const controller = new AbortController();
  let finished = false;
  const onClose = () => {
    if (!finished) controller.abort();
  };
  res.on('close', onClose);
  const emit = (event, data) => {
    if (finished || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch {
      controller.abort();
    }
  };
  const finish = () => {
    finished = true;
    res.off?.('close', onClose);
    if (!res.writableEnded) res.end();
  };
  return { emit, signal: controller.signal, finish };
}

async function runStream(req, res, work) {
  const { emit, signal, finish } = openSse(req, res);
  try {
    await work({ emit, requestSignal: signal });
  } catch (error) {
    const cancel = error.cancel || signal.aborted;
    emit(cancel ? 'cancelled' : 'error', { message: cancel ? '已停止' : (error.message || '追查失败') });
    if (!cancel) console.error(error);
  } finally {
    finish();
  }
}

function createApp() {
  return createServer(async (req, res) => {
  allowOrigin(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/chains') {
      sendJson(res, 200, CHAINS);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/preview') {
      const body = await readJson(req);
      const result = await previewTx(body);
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/add-node') {
      const body = await readJson(req);
      sendJson(res, 200, await addAddress(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/remove-node') {
      const body = await readJson(req);
      sendJson(res, 200, removeNode(body.sessionId, body.address));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/labels') {
      const body = await readJson(req);
      sendJson(res, 200, await lookupLabels(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/safe-owners') {
      const body = await readJson(req);
      sendJson(res, 200, { owners: await readSafeOwners(body.rpc, body.address) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const body = await readJson(req);
      sendJson(res, 200, { ok: cancelSession(body.sessionId) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trace') {
      const body = await readJson(req);
      await runStream(req, res, (ctx) => beginTrace({ ...body, ...ctx }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/continue') {
      const body = await readJson(req);
      await runStream(req, res, (ctx) => continueTrace({ ...body, ...ctx }));
      return;
    }
    sendJson(res, 404, { error: '没有这个接口' });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 400, { error: error.message || '请求失败' });
    else res.end();
  }
  });
}

export function startServer(port = PORT) {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`tx-tracer http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
