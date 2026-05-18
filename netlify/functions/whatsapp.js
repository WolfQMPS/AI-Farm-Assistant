const VERIFY_TOKEN = 'farmlearn123';
const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/hlkn6g7e7f1qfmiosrldlvojfc4i8oxr';

exports.handler = async (event) => {
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
    try {
      const makeRes = await fetch(MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: event.body,
      });
      const makeBody = await makeRes.text();
      console.log('Make response status:', makeRes.status);
      console.log('Make response body:', makeBody);

      if (!makeRes.ok) {
        console.error('Make rejected the request:', makeRes.status, makeBody);
      }
    } catch (e) {
      console.error('Forward to Make failed:', e.message);
    }
    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
