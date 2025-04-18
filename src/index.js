// src/index.js

// Hàm tạo HMAC-SHA256 signature sử dụng Web Crypto API
async function createHmacSha256(data, key) {
  const encoder = new TextEncoder();
  const keyBuffer = encoder.encode(key);
  const dataBuffer = encoder.encode(data);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Hàm gọi API PayOS để tạo link thanh toán
async function createPaymentLink(orderCode, amount, description, config) {
  let datasort = `amount=${amount}&cancelUrl=abc&description=${description}&orderCode=${orderCode}&returnUrl=abc`
  let signature = await createHmacSha256(datasort, config.cs_key);
  const data = {
    orderCode,
    amount,
    description,
    returnUrl: 'abc',
    cancelUrl: 'abc',
    expiredAt: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
    signature: signature
  };
  const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': config.c_id,
      'x-api-key': config.api_key,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Lỗi khi tạo link thanh toán: ${errorText}`);
  }

  const result = await response.json();
  return {
    orderCode: result.data.orderCode,
    qrCode: result.data.qrCode,
    paymentUrl: result.data.checkoutUrl,
  };
}

// Hàm xác minh webhook signature
async function verifyWebhookSignature(data, receivedSignature, config) {
  let dataStr = `amount=${data.amount}&cancelUrl=abc&description=${data.description}&orderCode=${data.orderCode}&returnUrl=abc`
  const calculatedSignature = await createHmacSha256(dataStr, config.cs_key);
  return calculatedSignature === receivedSignature;
}

// Hàm lấy cấu hình PayOS từ D1
async function getPayOSConfig(env, payChannelId) {
  const query = await env.DB.prepare(
    'SELECT api_key, c_id, cs_key FROM pay_channel WHERE id = ?'
  ).bind(payChannelId).first();
  return query;
}

// Hàm lấy thông tin máy từ bill ID
async function getDataMachineByBillId(env, id) {
  const query = await env.DB.prepare(
    `SELECT io_machine.*
     FROM "transactionss"
     JOIN io_machine ON "transactionss".machine_id = io_machine.id
     WHERE "transactionss".bill_id = ?`
  ).bind(id).first();
  return query;
}

// Hàm đọc transactionss
async function readtransactionss(env) {
  const query = await env.DB.prepare(
    'SELECT * FROM "transactionss" ORDER BY time_create DESC LIMIT 20'
  ).all();
  return query.results;
}

// Hàm retry API
async function callApiWithRetry(url, data, maxRetries = 3, retryDelay = 20000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error('API call failed');
      return await response.json();
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error('Gọi API thất bại sau tất cả các lần thử');
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Worker entry point
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    // Route: /create-bill
    if (method === 'POST' && url.pathname === '/create-bill') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let c1, c2, c3, c4;
        if (contentType.includes('application/json')) {
          ({ c1, c2, c3, c4 } = await request.json());
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          const body = await request.text();
          const params = new URLSearchParams(body);
          c1 = params.get('c1');
          c2 = params.get('c2');
          c3 = params.get('c3');
          c4 = params.get('c4');
        } else {
          return new Response(JSON.stringify({ error: 'Content-Type không hỗ trợ' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const amountNumber = parseFloat(c3);
        const billId = parseInt(String(Date.now()));
        const description = c4 ? `CFPAYOS${c4}` : 'CFPAYOS';
        const config = await getPayOSConfig(env, c1);
        if (!config) {
          return new Response(JSON.stringify({ error: 'Không tìm thấy cấu hình PayOS' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Lưu giao dịch vào D1
        await env.DB.prepare(
          'INSERT INTO "transactionss" (bill_id, machine_id, pay_channel, time_create, status) VALUES (?, ?, ?, ?, ?)'
        ).bind(billId, c2, c1, Math.floor(Date.now() / 1000), 'PENDING').run();


        const paymentQrcode = await createPaymentLink(billId, amountNumber, description, config);
        return new Response(JSON.stringify({
          c1: paymentQrcode.orderCode,
          c2: paymentQrcode.qrCode,
          c3: paymentQrcode.paymentUrl,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Lỗi /create-bill:', error.message);
        return new Response(JSON.stringify({
          success: false,
          message: 'Lỗi khi tạo link thanh toán',
          error: error.message,
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Route: /bill-confirm
    if (method === 'POST' && url.pathname === '/bill-confirm') {
      try {
        const { data, success, signature } = await request.json();
        const { orderCode, amount, description, accountNumber } = data;
        const status = success ? 'PAID' : 'CANCELLED';
        // verifyWebhookSignature
        // const config = await getPayOSConfig(env, accountNumber);
        // if (!config) {
        // return new Response(JSON.stringify({ error: 'Không tìm thấy cấu hình PayOS' }), {
        //     status: 400,
        //     headers: { 'Content-Type': 'application/json' },
        // });
        // }

        // const isValidSignature = await verifyWebhookSignature( data, signature, config);
        // if (!isValidSignature) {
        // return new Response(JSON.stringify({ error: 'Chữ ký webhook không hợp lệ' }), {
        //     status: 400,
        //     headers: { 'Content-Type': 'application/json' },
        // });
        // }
        const updateResult = await env.DB.prepare(
          'UPDATE "transactionss" SET status = ?, time_pay = ? WHERE bill_id = ?'
        ).bind(status, Math.floor(Date.now() / 1000), orderCode).run();

        // Check if any rows were affected (i.e., if orderCode exists)
        if (updateResult.meta.changes === 0) {
          return new Response(JSON.stringify({ "success": false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (status === 'PAID') {
          const dataMachine = await getDataMachineByBillId(env, orderCode);
          if (!dataMachine) {
            return new Response('Không tìm thấy thông tin máy', { status: 400 });
          }
          const apiUrl = `https://iot.ioeasy.com/api/${dataMachine.io_id}?apiKey=${dataMachine.io_key}`;
          const apiData = { cmd: `${dataMachine.pre_cmd},${amount},"${description}"` };

          await callApiWithRetry(apiUrl, apiData);
        }
        return new Response(JSON.stringify({ "success": true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Lỗi /bill-confirm:', error.message);
        return new Response('Webhook xử lý thành công nhưng gọi API thất bại', { status: 200 });
      }
    }

    // Route: /success
    if (method === 'GET' && url.pathname === '/success') {
      return new Response('Thanh toán thành công! Quay lại trang chủ.', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Route: /cancel
    if (method === 'GET' && url.pathname === '/cancel') {
      return new Response('Thanh toán đã bị hủy.', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Route: /logs
    if (method === 'GET' && url.pathname === '/logs') {
      try {
        const logs = await readtransactionss(env);
        return new Response(JSON.stringify(logs), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Lỗi /logs:', error.message);
        return new Response(JSON.stringify({ error: 'Lỗi khi lấy logs' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};