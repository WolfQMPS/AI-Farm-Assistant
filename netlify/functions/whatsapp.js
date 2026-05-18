const https = require('https');
const url = require('url');

const VERIFY_TOKEN = 'farmlearn123';
const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/hlkn6g7e7f1qfmiosrldlvojfc4i8oxr';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function forwardToMake(body) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(MAKE_WEBHOOK_URL);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log('Make status:', res.statusCode);
        console.log('Make body:', responseData);
        resolve({ status: res.statusCode, body: responseData });
      });
    });
    req.on('error', (e) => {
      console.error('Make request error:', e.message);
      reject(e);
    });
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  console.log('Method:', event.httpMethod);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const mode = params['hub.mode'];
    const token = params['hub.verify_token'];
    const challenge = params['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return { statusCode: 200, headers: CORS_HEADERS, body: challenge };
    }
    return { statusCode: 403, headers: CORS_HEADERS, body: 'Forbidden' };
  }

  if (event.httpMethod === 'POST') {
    console.log('POST body:', event.body);
    try {
      const result = await forwardToMake(event.body);
      console.log('Make responded:', result.status, result.body);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true, makeStatus: result.status }),
      };
    } catch (e) {
      console.error('Forward failed:', e.message);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: false, error: e.message }),
      };
    }
  }

  return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
};
