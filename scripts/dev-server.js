const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PROXY_TARGET = process.env.DEV_PROXY_TARGET || '';
const MODBUS_TARGET = process.env.DEV_MODBUS_TARGET || '';
const MODBUS_DEFAULT = !!process.env.DEV_MODBUS;
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// --- Modbus host resolution ---

function getModbusHostPort() {
  if (MODBUS_TARGET) {
    const parts = MODBUS_TARGET.split(':');
    return { host: parts[0], port: parseInt(parts[1] || '502', 10) };
  }
  if (PROXY_TARGET) {
    const url = new URL(PROXY_TARGET);
    return { host: url.hostname, port: 502 };
  }
  return null;
}

// --- Modbus TCP client ---

function modbusReadRegisters(host, port, unitId, fc, reads) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const results = [];
    let currentRead = 0;
    let responseData = Buffer.alloc(0);
    let readTimer;

    function addrHex(idx) {
      return '0x' + reads[idx].start.toString(16).padStart(4, '0');
    }

    function buildRequest(startAddr, quantity) {
      const transactionId = Math.floor(Math.random() * 0xFFFF);
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(transactionId, 0);
      buf.writeUInt16BE(0, 2);
      buf.writeUInt16BE(6, 4);
      buf.writeUInt8(unitId, 6);
      buf.writeUInt8(fc, 7);
      buf.writeUInt16BE(startAddr, 8);
      buf.writeUInt16BE(quantity, 10);
      return buf;
    }

    function sendNext() {
      const { start, count } = reads[currentRead];
      const req = buildRequest(start, count);
      responseData = Buffer.alloc(0);
      console.log(`[modbus] request ${currentRead + 1}/${reads.length} (${addrHex(currentRead)}) qty=${count}: ${req.toString('hex')}`);
      clearTimeout(readTimer);
      readTimer = setTimeout(() => {
        console.log(`[modbus] READ TIMEOUT (${addrHex(currentRead)}) after 5s, received ${responseData.length} bytes: ${responseData.toString('hex')}`);
        cleanup();
        reject(new Error(`Modbus read timeout at ${addrHex(currentRead)} from ${host}:${port}`));
      }, 5000);
      socket.write(req);
    }

    const cleanup = () => {
      clearTimeout(readTimer);
      socket.destroy();
    };

    const connectTimer = setTimeout(() => {
      console.log(`[modbus] CONNECT TIMEOUT after 5s to ${host}:${port}`);
      cleanup();
      reject(new Error(`Modbus connect timeout to ${host}:${port}`));
    }, 5000);

    socket.connect(port, host, () => {
      clearTimeout(connectTimer);
      console.log(`[modbus] connected to ${host}:${port}, sending ${reads.length} reads`);
      sendNext();
    });

    socket.on('data', (chunk) => {
      console.log(`[modbus] data chunk (${addrHex(currentRead)}): ${chunk.length} bytes: ${chunk.toString('hex')}`);
      responseData = Buffer.concat([responseData, chunk]);
      if (responseData.length < 9) return;
      const respLength = responseData.readUInt16BE(4);
      if (responseData.length < 6 + respLength) return;

      clearTimeout(readTimer);
      console.log(`[modbus] response complete (${addrHex(currentRead)}): ${responseData.length} bytes`);

      const respFc = responseData.readUInt8(7);
      if (respFc & 0x80) {
        const errorCode = responseData.readUInt8(8);
        console.log(`[modbus] ERROR (${addrHex(currentRead)}): FC=0x${respFc.toString(16)} code=${errorCode}`);
        cleanup();
        reject(new Error(`Modbus error at ${addrHex(currentRead)}: FC=0x${respFc.toString(16)} code=${errorCode}`));
        return;
      }

      const byteCount = responseData.readUInt8(8);
      const registers = [];
      for (let i = 0; i < byteCount; i += 2) {
        registers.push(responseData.readUInt16BE(9 + i));
      }
      console.log(`[modbus] OK (${addrHex(currentRead)}): ${registers.length} registers`);
      results.push(registers);

      currentRead++;
      if (currentRead < reads.length) {
        sendNext();
      } else {
        cleanup();
        resolve(results);
      }
    });

    socket.on('close', (hadError) => {
      console.log(`[modbus] socket closed hadError=${hadError}`);
    });

    socket.on('error', (err) => {
      console.log(`[modbus] SOCKET ERROR (${addrHex(currentRead)}): ${err.message}`);
      cleanup();
      reject(err);
    });
  });
}

// --- Modbus-to-HTTP data mapping ---

function modbusToHttpData(regs1, regs2, regs3) {
  const d = new Array(171).fill(0);

  // regs1: start 0x0003, count 37 (0x0003–0x0027)
  // regs2: start 0x0046, count 6  (0x0046–0x004B)
  // regs3: start 0x006A, count 45 (0x006A–0x0096)
  const r1 = (addr) => regs1[addr - 0x0003];
  const r2 = (addr) => regs2[addr - 0x0046];
  const r3 = (addr) => regs3[addr - 0x006A];

  // Grid voltage/current/power (read 3)
  d[0] = r3(0x006A);   // GridAVoltage
  d[1] = r3(0x006E);   // GridBVoltage
  d[2] = r3(0x0072);   // GridCVoltage
  d[3] = r3(0x006B);   // GridACurrent (int16, app interprets as signed)
  d[4] = r3(0x006F);   // GridBCurrent
  d[5] = r3(0x0073);   // GridCCurrent
  d[6] = r3(0x006C);   // GridAPower
  d[7] = r3(0x0070);   // GridBPower
  d[8] = r3(0x0074);   // GridCPower

  // PV (read 1)
  d[10] = r1(0x0003);  // Vdc1
  d[11] = r1(0x0004);  // Vdc2
  d[12] = r1(0x0005);  // Idc1
  d[13] = r1(0x0006);  // Idc2
  d[14] = r1(0x000A);  // PowerDc1
  d[15] = r1(0x000B);  // PowerDc2

  // Grid frequency (read 3)
  d[16] = r3(0x006D);  // FreqacA
  d[17] = r3(0x0071);  // FreqacB
  d[18] = r3(0x0075);  // FreqacC

  // RunMode (read 1)
  d[19] = r1(0x0009);

  // EPS / Off-grid (read 3)
  d[23] = r3(0x0076);  // EPSAVoltage
  d[24] = r3(0x007A);  // EPSBVoltage
  d[25] = r3(0x007E);  // EPSCVoltage
  d[26] = r3(0x0077);  // EPSACurrent
  d[27] = r3(0x007B);  // EPSBCurrent
  d[28] = r3(0x007F);  // EPSCCurrent
  d[29] = r3(0x0078);  // EPSAPower
  d[30] = r3(0x007C);  // EPSBPower
  d[31] = r3(0x0080);  // EPSCPower

  // Feed-in power (read 2) — 32-bit signed, two registers map directly
  d[34] = r2(0x0046);  // feedInPower high word
  d[35] = r2(0x0047);  // feedInPower low word

  // Battery power (read 1) — int16
  d[41] = r1(0x0016);

  // Yield total/today (read 3)
  d[68] = r3(0x0094);  // Yield_Total high word
  d[69] = r3(0x0095);  // Yield_Total low word
  d[70] = r3(0x0096);  // Yield_Today

  // Feed-in / consume energy totals (read 2) — 32-bit unsigned
  d[86] = r2(0x0048);  // FeedInEnergy high
  d[87] = r2(0x0049);  // FeedInEnergy low
  d[88] = r2(0x004A);  // ConsumeEnergy high
  d[89] = r2(0x004B);  // ConsumeEnergy low

  // Battery state (read 1)
  d[103] = r1(0x001C); // BatteryCapacity (%)
  d[105] = r1(0x0018); // BatteryTemperature (int16, °C)

  // BatteryRemainingEnergy: Modbus uint32 Wh → d[106] in 0.1 kWh units
  // d[106]/10 = kWh, so d[106] = Wh / 100
  const battRemWh = ((r1(0x0026) << 16) | r1(0x0027)) >>> 0;
  d[106] = Math.round(battRemWh / 100);

  // BatteryVoltage: Modbus reg/10 → V, HTTP r32u(d[169],d[170])/100 → V
  // So d[170] = modbusReg * 10 (fits in 16 bits)
  d[169] = 0;
  d[170] = r1(0x0014) * 10;

  return d;
}

// --- Route handlers ---

function serveStatic(req, res) {
  let filePath = path.join(WEB_DIR, req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function handleHttpProxy(req, res) {
  if (!PROXY_TARGET) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('DEV_PROXY_TARGET not set');
    return;
  }

  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    body = Buffer.concat(body);

    const target = new URL('/', PROXY_TARGET);
    const options = {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { ...req.headers, host: target.host },
    };

    const proxyReq = http.request(options, proxyRes => {
      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['access-control-allow-origin'] = '*';
      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    });

    proxyReq.end(body);
  });
}

async function handleModbus(req, res) {
  const target = getModbusHostPort();
  if (!target) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('No Modbus target: set DEV_PROXY_TARGET or DEV_MODBUS_TARGET');
    return;
  }

  // Drain request body (not used, but must be consumed)
  req.resume();
  await new Promise(resolve => req.on('end', resolve));

  try {
    const { host, port } = target;
    const unitId = 1;
    const fc = 0x04;

    const [regs1, regs2, regs3] = await modbusReadRegisters(host, port, unitId, fc, [
      { start: 0x0003, count: 37 },
      { start: 0x0046, count: 6 },
      { start: 0x006A, count: 45 },
    ]);

    const data = modbusToHttpData(regs1, regs2, regs3);
    const result = {
      type: 'X3-Hybrid G4',
      sn: 'MODBUS',
      ver: '3.006.04',
      Data: data,
      Information: [0, 0, 0, 0, 0, 0, 0, 0, 'MODBUS'],
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Modbus error: ${err.message}`);
  }
}

// --- Server ---

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    const url = req.url.split('?')[0];
    if (url === '/http') {
      handleHttpProxy(req, res);
    } else if (url === '/modbus') {
      handleModbus(req, res);
    } else if (MODBUS_DEFAULT) {
      handleModbus(req, res);
    } else {
      handleHttpProxy(req, res);
    }
  } else {
    if (req.url.split('?')[0] === '/modbus') {
      handleModbus(req, res);
    } else {
      serveStatic(req, res);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Dev server: http://localhost:${PORT}`);
  if (PROXY_TARGET) {
    console.log(`  POST /http → proxy to ${PROXY_TARGET}`);
  }
  const modbusTarget = getModbusHostPort();
  if (modbusTarget) {
    console.log(`  POST /modbus → Modbus TCP ${modbusTarget.host}:${modbusTarget.port}`);
  }
  console.log(`  POST / → ${MODBUS_DEFAULT ? 'Modbus' : 'HTTP proxy'} (DEV_MODBUS=${MODBUS_DEFAULT ? '1' : 'unset'})`);
  if (!PROXY_TARGET && !modbusTarget) {
    console.log('Warning: neither DEV_PROXY_TARGET nor DEV_MODBUS_TARGET set, POST requests will fail');
  }
});
