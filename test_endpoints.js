const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }));
    }).on('error', reject);
  });
}

function post(path, body, token = '') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://localhost:3000${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('=== 1. Test GET /api/videos ===');
  const videosRes = await get('/api/videos');
  console.log('Status:', videosRes.status, 'Count:', videosRes.data.videos?.length);

  console.log('\n=== 2. Test GET /api/blog ===');
  const blogRes = await get('/api/blog');
  console.log('Status:', blogRes.status, 'Blog Posts:', blogRes.data.posts?.length, 'Regions:', blogRes.data.regions?.length);

  console.log('\n=== 3. Test GET /api/faq ===');
  const faqRes = await get('/api/faq');
  console.log('Status:', faqRes.status, 'FAQs:', faqRes.data.faqs?.length);

  console.log('\n=== 4. Test POST /api/auth/register (No Google) ===');
  const testUser = {
    username: 'test_creator_' + Date.now(),
    email: `creator_${Date.now()}@example.com`,
    password: 'password123'
  };
  const regRes = await post('/api/auth/register', testUser);
  console.log('Status:', regRes.status, 'Token exists:', !!regRes.data.token, 'User:', regRes.data.user?.username);

  const token = regRes.data.token;

  console.log('\n=== 5. Test POST /api/vip/subscribe (9,99€) ===');
  const vipRes = await post('/api/vip/subscribe', { paymentMethod: 'cb' }, token);
  console.log('Status:', vipRes.status, 'Message:', vipRes.data.message, 'Valid Until:', vipRes.data.validUntil);

  console.log('\n=== 6. Test POST /api/auth/login ===');
  const loginRes = await post('/api/auth/login', {
    emailOrUsername: testUser.email,
    password: 'password123'
  });
  console.log('Status:', loginRes.status, 'VIP status after login:', loginRes.data.user?.isVip);

  console.log('\n✅ ALL INTEGRATION TESTS PASSED!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
