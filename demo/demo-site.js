// A tiny "noisy" product page for demonstrating the detector locally.
// Every load changes the clock, view counter, rotating ad and CSRF token (noise).
// POST /admin/price?value=799 changes the price (a real change).
// POST /admin/image?theme=red swaps the product photo, POST /admin/layout?value=right moves it:
// both are VISUAL-ONLY changes (the page text stays exactly the same).
const express = require('express');
const crypto = require('crypto');
const app = express();
let price = 999;
let stock = 'In stock';
let theme = 'blue';
let layout = 'left';
const THEMES = { blue: ['#3949ab', '#00acc1'], red: ['#c62828', '#ff8f00'], green: ['#2e7d32', '#c0ca33'] };
const ads = ['Buy sneakers 50% off!', 'New phones are here', 'Free shipping today only', 'Win a trip to Goa'];

app.get('/product', (req, res) => {
  const now = new Date();
  res.send(`<!doctype html><html><head><title>Campus Store: VIT Hoodie</title>
  <style>body{font-family:system-ui;margin:0;background:#fafafa}header{background:#1a237e;color:#fff;padding:16px 32px;display:flex;justify-content:space-between}
  main{max-width:900px;margin:30px auto;display:flex;gap:40px;background:#fff;padding:30px;border-radius:12px;box-shadow:0 2px 8px #0001}
  .photo{width:320px;height:320px;border-radius:12px;display:block}
  .price{font-size:40px;color:#c62828;font-weight:700}.ad-slot{background:#fff3cd;padding:12px;margin:20px auto;max-width:900px;border-radius:8px;text-align:center}
  footer{text-align:center;color:#888;padding:20px}</style></head>
  <body><header><b>VIT Campus Store</b><span>Server time: ${now.toISOString().replace('T', ' ').slice(0, 19)}</span></header>
  <div class="ad-slot">${ads[Math.floor(Math.random() * ads.length)]}</div>
  <main style="flex-direction:${layout === 'right' ? 'row-reverse' : 'row'}"><img class="photo" src="/img/hoodie-${theme}.svg" alt=""><div>
    <h1>VIT Official Hoodie</h1>
    <p id="price" class="price">₹${price}</p>
    <p id="stock">${stock}</p>
    <p>Soft cotton hoodie with the VIT crest. Sizes S to XXL.</p>
    <p><span>${(1000 + Math.floor(Math.random() * 9000)).toLocaleString('en-IN')} views</span> · updated ${Math.floor(Math.random() * 59) + 1} minutes ago</p>
    <form><input type="hidden" name="csrf" value="${crypto.randomBytes(16).toString('hex')}"><button>Add to cart</button></form>
  </div></main>
  <footer>Session ${crypto.randomUUID()}</footer></body></html>`);
});
app.get('/img/hoodie-:theme.svg', (req, res) => {
  const [a, b] = THEMES[req.params.theme] || THEMES.blue;
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="320" rx="12" fill="url(#g)"/><path d="M110 90l50-20 50 20 40 40-25 25-15-12v107H110V143l-15 12-25-25z" fill="#fff" opacity=".9"/></svg>`);
});
app.post('/admin/image', (req, res) => { if (THEMES[req.query.theme]) theme = req.query.theme; res.json({ theme }); });
app.post('/admin/layout', (req, res) => { layout = req.query.value === 'right' ? 'right' : 'left'; res.json({ layout }); });
app.post('/admin/price', (req, res) => { price = Number(req.query.value) || price; res.json({ price }); });
app.post('/admin/stock', (req, res) => { stock = String(req.query.value || stock); res.json({ stock }); });
app.listen(Number(process.env.DEMO_PORT || 4000), () => console.log('Demo store on http://localhost:4000/product'));
