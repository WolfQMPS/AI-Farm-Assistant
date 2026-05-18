const https = require('https');
const url = require('url');

const VERIFY_TOKEN = 'farmlearn123';
const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/hlkn6g7e7f1qfmiosrldlvojfc4i8oxr';

function forwardToMake(body) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(MAKE_WEBHOOK_URL);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Make status:', res.statusCode);
        console.log('Make body:', data);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', (e) => {
      console.error('Make request error:', e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  console.log('Incoming method:', event.httpMethod);

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod === 'POST') {
    console.log('Received POST body:', event.body);
    try {
      const result = await forwardToMake(event.body);
      console.log('Forwarded to Make successfully:', result.status);
    } catch (e) {
      console.error('Failed to forward to Make:', e.message);
    }
    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
