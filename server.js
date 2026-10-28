// POS server - Node 24, CommonJS (Passenger friendly). Uses built-in node:sqlite, no native build needed.
const express = require('express'), crypto = require('crypto'), path = require('path'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const dir = path.join(__dirname, 'data'); fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'pos.db'));
db.exec(`
create table if not exists users(id integer primary key, name text, username text unique, pass text, role text);
create table if not exists tables_(id integer primary key, no integer unique, waiter_id integer);
create table if not exists categories(id integer primary key, name text unique);
create table if not exists subs(id integer primary key, cat_id integer, name text, unique(cat_id,name));
create table if not exists products(id integer primary key, sub_id integer, name text, qty real default 0, cost real default 0, price real default 0, expiry text, reorder real default 0);
create table if not exists config(k text primary key, v text);
create table if not exists days(id integer primary key, opened text, closed text);
create table if not exists orders(id integer primary key, table_no integer, waiter_id integer, day_id integer, status text, remark text, discount real default 0, created text);
create table if not exists items(id integer primary key, order_id integer, product_id integer, name text, price real, cost real, qty real, status text, comp integer default 0, ts text);
create table if not exists payments(id integer primary key, order_id integer, method text, amount real, kind text, day_id integer, user text, ts text);
create table if not exists expenses(id integer primary key, day_id integer, title text, amount real, user text, ts text);
create table if not exists debtors(id integer primary key, order_id integer, name text, amount real, paid real default 0, day_id integer, ts text);
create table if not exists logs(id integer primary key, day_id integer, type text, detail text, amount real, user text, ts text);
`);
try { db.exec('alter table users add column avatar text'); } catch (e) {}
const q = (s, ...p) => db.prepare(s).all(...p), one = (s, ...p) => db.prepare(s).get(...p), run = (s, ...p) => db.prepare(s).run(...p);
const now = () => new Date().toISOString();
const hash = (p, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(p, salt, 32).toString('hex');
const check = (p, h) => hash(p, h.split(':')[0]) === h;
if (!one('select id from users limit 1')) run('insert into users(name,username,pass,role) values(?,?,?,?)', 'Administrator', 'admin', hash('admin123'), 'admin');
const defaults = { name: 'My Business', address: '', logo: '', email: '', phone: '', whatsapp: '', website: '', login_bg: '', vat_on: '0', vat_rate: '7.5', service_on: '0', service_rate: '10', cons_on: '0', cons_rate: '5' };
for (const [k, v] of Object.entries(defaults)) run('insert or ignore into config values(?,?)', k, v);
const cfg = () => Object.fromEntries(q('select * from config').map(r => [r.k, r.v]));
const day = () => one('select * from days where closed is null') || one('select * from days where id=?', run('insert into days(opened) values(?)', now()).lastInsertRowid);

function totals(o) {
  const c = cfg(), items = q("select * from items where order_id=? and status!='void'", o.id);
  const sub = items.reduce((a, i) => a + (i.comp ? 0 : i.price * i.qty), 0), disc = Math.min(o.discount || 0, sub), base = sub - disc;
  const sc = c.service_on == '1' ? base * c.service_rate / 100 : 0, cn = c.cons_on == '1' ? base * c.cons_rate / 100 : 0, vat = c.vat_on == '1' ? base * c.vat_rate / 100 : 0;
  return { items, sub, disc, sc, cn, vat, total: base + sc + cn + vat };
}
const full = o => o && { ...o, ...totals(o), waiter: (one('select name from users where id=?', o.waiter_id) || {}).name, cfg: (({ name, address, logo, phone }) => ({ name, address, logo, phone }))(cfg()) };
const log = (type, detail, amount, user) => run('insert into logs(day_id,type,detail,amount,user,ts) values(?,?,?,?,?,?)', day().id, type, detail, amount || 0, user, now());
const openOrder = t => one("select * from orders where table_no=? and status in('open','billed') and day_id=?", t, day().id);

const sessions = new Map(), app = express();
app.use(express.json({ limit: '12mb' })); app.use(express.static(path.join(__dirname, 'public')));
const wrap = (roles, fn) => (req, res) => {
  try {
    const u = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
    if (!u || (roles && !roles.includes(u.role))) return res.status(403).json({ error: 'Not allowed' });
    res.json(fn(req, u) ?? { ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
};
const A = ['admin'], AC = ['admin', 'cashier'], ALL = null, W = ['waiter', 'admin', 'cashier'];

app.post('/api/login', (req, res) => {
  const u = one('select * from users where username=?', String(req.body.username || '').trim());
  if (!u || !check(String(req.body.password || ''), u.pass)) return res.status(401).json({ error: 'Wrong username or password' });
  const token = crypto.randomBytes(24).toString('hex'), s = { id: u.id, name: u.name, role: u.role, username: u.username, avatar: u.avatar || '' };
  sessions.set(token, s); res.json({ token, user: s, cfg: (({ name, logo }) => ({ name, logo }))(cfg()) });
});
app.get('/api/public', (req, res) => { const c = cfg(); res.json({ name: c.name, logo: c.logo, login_bg: c.login_bg }); });
app.get('/api/config', wrap(ALL, () => cfg()));
app.post('/api/config', wrap(A, req => { for (const [k, v] of Object.entries(req.body)) if (k in defaults) run('insert or replace into config values(?,?)', k, String(v)); }));

// ---- users & tables
app.get('/api/users', wrap(A, () => q('select id,name,username,role from users').map(u => ({ ...u, tables: q('select no from tables_ where waiter_id=? order by no', u.id).map(t => t.no) }))));
app.post('/api/users', wrap(A, req => { const b = req.body; run('insert into users(name,username,pass,role) values(?,?,?,?)', b.name, b.username, hash(b.password), b.role); }));
app.put('/api/users/:id', wrap(A, req => { const b = req.body, u = one('select * from users where id=?', req.params.id); if (!u) throw new Error('No such user'); if (u.role === 'admin' && b.role !== 'admin' && q("select id from users where role='admin'").length < 2) throw new Error('Keep at least one admin'); run('update users set name=?,username=?,role=?,pass=? where id=?', b.name, b.username, b.role, b.password ? hash(b.password) : u.pass, u.id); for (const [t, s] of sessions) if (s.id === u.id) { s.name = b.name; s.role = b.role; s.username = b.username; } }));
app.post('/api/me', wrap(ALL, (req, u) => { run('update users set name=?, pass=coalesce(?,pass), avatar=coalesce(?,avatar) where id=?', req.body.name || u.name, req.body.password ? hash(req.body.password) : null, req.body.avatar || null, u.id); u.name = req.body.name || u.name; if (req.body.avatar) u.avatar = req.body.avatar; }));
app.delete('/api/users/:id', wrap(A, req => { if (one('select role from users where id=?', req.params.id)?.role === 'admin' && q("select id from users where role='admin'").length < 2) throw new Error('Keep at least one admin'); run('delete from users where id=?', req.params.id); run('update tables_ set waiter_id=null where waiter_id=?', req.params.id); }));
app.post('/api/users/:id/tables', wrap(A, req => { // body {tables:[1,2,3]}
  run('delete from tables_ where waiter_id=?', req.params.id);
  for (const n of req.body.tables) { run('insert or ignore into tables_(no) values(?)', n); run('update tables_ set waiter_id=? where no=?', req.params.id, n); }
}));
app.get('/api/my-tables', wrap(W, (req, u) => q('select t.no from tables_ t where waiter_id=? order by no', u.id).map(t => ({ no: t.no, busy: !!openOrder(t.no) }))));
app.get('/api/all-tables', wrap(ALL, () => q('select no from tables_ order by no').map(t => t.no)));

// ---- inventory
app.get('/api/catalog', wrap(ALL, () => ({ cats: q('select * from categories order by name'), subs: q('select * from subs order by name'), products: q('select p.*, s.name sub, c.name cat, s.cat_id from products p join subs s on s.id=p.sub_id join categories c on c.id=s.cat_id order by p.name') })));
app.post('/api/categories', wrap(A, req => run('insert into categories(name) values(?)', req.body.name.trim())));
app.post('/api/subs', wrap(A, req => run('insert into subs(cat_id,name) values(?,?)', req.body.cat_id, req.body.name.trim())));
app.post('/api/products', wrap(A, req => { const b = req.body; if (b.id) run('update products set sub_id=?,name=?,qty=?,cost=?,price=?,expiry=?,reorder=? where id=?', b.sub_id, b.name, b.qty, b.cost, b.price, b.expiry || null, b.reorder || 0, b.id); else run('insert into products(sub_id,name,qty,cost,price,expiry,reorder) values(?,?,?,?,?,?,?)', b.sub_id, b.name, b.qty, b.cost, b.price, b.expiry || null, b.reorder || 0); }));
app.delete('/api/products/:id', wrap(A, (req, u) => { const p = one('select * from products where id=?', req.params.id); if (p) { log('store_delete', `${p.name} (qty ${p.qty})`, p.qty * p.cost, u.name); run('delete from products where id=?', p.id); } }));
app.post('/api/import', wrap(A, req => { // body {data: base64 xlsx}
  const wb = XLSX.read(Buffer.from(req.body.data, 'base64'), { type: 'buffer' }), rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const g = (r, ...ks) => { for (const k of Object.keys(r)) if (ks.includes(k.toLowerCase().replace(/[^a-z]/g, ''))) return r[k]; return ''; };
  let n = 0;
  for (const r of rows) {
    const cat = String(g(r, 'category')).trim(), sub = String(g(r, 'subcategory', 'sub')).trim(), name = String(g(r, 'product', 'productname', 'name', 'item')).trim();
    if (!cat || !sub || !name) continue;
    run('insert or ignore into categories(name) values(?)', cat); const cid = one('select id from categories where name=?', cat).id;
    run('insert or ignore into subs(cat_id,name) values(?,?)', cid, sub); const sid = one('select id from subs where cat_id=? and name=?', cid, sub).id;
    const v = [Number(g(r, 'quantity', 'qty')) || 0, Number(g(r, 'costprice', 'cost')) || 0, Number(g(r, 'sellingprice', 'price')) || 0, String(g(r, 'expiredate', 'expiry')) || null, Number(g(r, 'reorder', 'reordervalue')) || 0];
    const ex = one('select id from products where sub_id=? and name=?', sid, name);
    if (ex) run('update products set qty=?,cost=?,price=?,expiry=?,reorder=? where id=?', ...v, ex.id); else run('insert into products(sub_id,name,qty,cost,price,expiry,reorder) values(?,?,?,?,?,?,?)', sid, name, ...v);
    n++;
  }
  return { imported: n };
}));

// ---- orders (waiter flow)
app.get('/api/orders/table/:no', wrap(W, req => full(openOrder(+req.params.no)) || null));
app.post('/api/orders/add', wrap(W, (req, u) => { // {table, items:[{id,qty}], remark}
  const d = day(); let o = openOrder(req.body.table);
  if (!o) o = one('select * from orders where id=?', run('insert into orders(table_no,waiter_id,day_id,status,remark,created) values(?,?,?,?,?,?)', req.body.table, u.id, d.id, 'open', '', now()).lastInsertRowid);
  const added = [];
  for (const it of req.body.items) {
    const p = one('select * from products where id=?', it.id); if (!p) continue;
    const held = one("select coalesce(sum(qty),0) s from items where product_id=? and status='new'", p.id).s;
    if (p.qty - held < it.qty) throw new Error(`Not enough ${p.name} in store (${p.qty - held} left)`);
    const id = run('insert into items(order_id,product_id,name,price,cost,qty,status,ts) values(?,?,?,?,?,?,?,?)', o.id, p.id, p.name, p.price, p.cost, it.qty, 'new', now()).lastInsertRowid; added.push({ name: p.name, qty: it.qty, price: p.price });
  }
  if (req.body.remark) run("update orders set remark=trim(remark||' '||?), status='open' where id=?", req.body.remark, o.id); else run("update orders set status='open' where id=?", o.id);
  return { docket: { order: o.id, table: o.table_no, waiter: u.name, remark: req.body.remark || '', items: added, time: now() }, order: full(one('select * from orders where id=?', o.id)) };
}));
app.post('/api/orders/:id/confirm', wrap(W, req => {
  for (const i of q("select * from items where order_id=? and status='new'", req.params.id)) { run('update products set qty=qty-? where id=?', i.qty, i.product_id); run("update items set status='ok' where id=?", i.id); }
  return full(one('select * from orders where id=?', req.params.id));
}));
app.post('/api/orders/:id/cancel-new', wrap(W, req => { run("update items set status='void' where order_id=? and status='new'", req.params.id); }));
app.post('/api/orders/:id/bill', wrap(W, req => { if (q("select id from items where order_id=? and status='new'", req.params.id).length) throw new Error('Confirm the new items first'); run("update orders set status='billed' where id=?", req.params.id); return full(one('select * from orders where id=?', req.params.id)); }));
app.get('/api/orders/:id', wrap(ALL, req => full(one('select * from orders where id=?', req.params.id))));
app.post('/api/orders/:id/pay', wrap(W, (req, u) => { // {payments:[{method,amount}], debtor:{name,amount}}
  const o = one('select * from orders where id=?', req.params.id), t = totals(o), d = day();
  const pays = (req.body.payments || []).filter(p => p.amount > 0), debt = req.body.debtor?.amount > 0 ? req.body.debtor : null;
  const paid = pays.reduce((a, p) => a + +p.amount, 0) + (debt ? +debt.amount : 0);
  if (Math.abs(paid - t.total) > 0.01) throw new Error(`Payments (${paid.toFixed(2)}) must equal total (${t.total.toFixed(2)})`);
  for (const p of pays) run('insert into payments(order_id,method,amount,kind,day_id,user,ts) values(?,?,?,?,?,?,?)', o.id, p.method, p.amount, 'sale', d.id, u.name, now());
  if (debt) run('insert into debtors(order_id,name,amount,day_id,ts) values(?,?,?,?,?)', o.id, debt.name || 'Unknown', debt.amount, d.id, now());
  run("update orders set status='paid' where id=?", o.id); return full(one('select * from orders where id=?', o.id));
}));

// ---- tracking
app.get('/api/pending', wrap(AC, () => q("select * from orders where status in('open','billed') and day_id=? order by table_no", day().id).map(full)));
app.post('/api/items/:id/void', wrap(AC, (req, u) => { const i = one('select * from items where id=?', req.params.id); if (i.status === 'ok') run('update products set qty=qty+? where id=?', i.qty, i.product_id); run("update items set status='void' where id=?", i.id); log('void', `${i.name} x${i.qty} table ${one('select table_no from orders where id=?', i.order_id).table_no}. ${req.body.reason || ''}`, i.price * i.qty, u.name); }));
app.post('/api/orders/:id/void', wrap(AC, (req, u) => { for (const i of q("select * from items where order_id=? and status!='void'", req.params.id)) { if (i.status === 'ok') run('update products set qty=qty+? where id=?', i.qty, i.product_id); run("update items set status='void' where id=?", i.id); log('void', `${i.name} x${i.qty} (void all). ${req.body.reason || ''}`, i.price * i.qty, u.name); } run("update orders set status='void' where id=?", req.params.id); }));
app.post('/api/items/:id/comp', wrap(AC, (req, u) => { const i = one('select * from items where id=?', req.params.id); run('update items set comp=1 where id=?', i.id); log('comp', `${i.name} x${i.qty}. ${req.body.reason || ''}`, i.price * i.qty, u.name); }));
app.post('/api/orders/:id/discount', wrap(AC, (req, u) => { run("update orders set discount=?, status='open' where id=?", +req.body.amount || 0, req.params.id); log('discount', `Order ${req.params.id}. ${req.body.reason || ''}`, +req.body.amount || 0, u.name); }));
app.post('/api/orders/:id/transfer', wrap(AC, req => { // {to, itemIds?}
  const from = one('select * from orders where id=?', req.params.id); let to = openOrder(+req.body.to);
  if (!to) to = one('select * from orders where id=?', run('insert into orders(table_no,waiter_id,day_id,status,remark,created) values(?,?,?,?,?,?)', +req.body.to, (one('select waiter_id from tables_ where no=?', +req.body.to) || {}).waiter_id || from.waiter_id, from.day_id, 'open', '', now()).lastInsertRowid);
  if (to.id === from.id) throw new Error('Pick a different table');
  const ids = req.body.itemIds?.length ? req.body.itemIds : q("select id from items where order_id=? and status!='void'", from.id).map(i => i.id);
  for (const id of ids) run('update items set order_id=? where id=? and order_id=?', to.id, id, from.id);
  if (!q("select id from items where order_id=? and status!='void'", from.id).length) run("update orders set status='merged' where id=?", from.id);
  run("update orders set status='open' where id in(?,?)", from.id, to.id);
}));

// ---- cashier
app.get('/api/debtors', wrap(AC, () => q('select * from debtors where paid<amount order by ts')));
app.post('/api/debtors/:id/clear', wrap(AC, (req, u) => { const d = one('select * from debtors where id=?', req.params.id), a = Math.min(+req.body.amount, d.amount - d.paid); run('update debtors set paid=paid+? where id=?', a, d.id); run('insert into payments(order_id,method,amount,kind,day_id,user,ts) values(?,?,?,?,?,?,?)', d.order_id, req.body.method || 'cash', a, 'debt', day().id, u.name, now()); }));
app.post('/api/inflow', wrap(AC, (req, u) => run('insert into payments(order_id,method,amount,kind,day_id,user,ts) values(null,?,?,?,?,?,?)', req.body.method || 'cash', +req.body.amount, 'received: ' + (req.body.note || ''), day().id, u.name, now())));
app.post('/api/expenses', wrap(['admin', 'cashier', 'accountant'], (req, u) => run('insert into expenses(day_id,title,amount,user,ts) values(?,?,?,?,?)', day().id, req.body.title, +req.body.amount, u.name, now())));
app.get('/api/recent-orders', wrap(AC, () => q("select id,table_no,status from orders where day_id=? and status='paid' order by id desc limit 50", day().id).map(full)));

app.post('/api/clear', wrap(A, (req, u) => {
  const me = one('select * from users where id=?', u.id); if (!check(String(req.body.password || ''), me.pass)) throw new Error('Wrong password');
  const s = req.body.sections || [];
  if (s.includes('inventory')) { run('delete from products'); run('delete from subs'); run('delete from categories'); }
  if (s.includes('sales')) { run('delete from items'); run('delete from orders'); run('delete from debtors'); run('delete from payments where order_id is not null'); }
  if (s.includes('transactions')) { run('delete from expenses'); run('delete from logs'); run('delete from payments where order_id is null'); }
}));
// ---- business day
app.get('/api/day', wrap(ALL, () => ({ ...day(), days: q('select * from days order by id desc limit 60') })));
app.post('/api/day/end', wrap(A, () => { const d = day(); if (q("select id from orders where status in('open','billed') and day_id=?", d.id).length) throw new Error('Settle or void all pending tables before ending the day'); run('update days set closed=? where id=?', now(), d.id); day(); }));

// ---- dashboard & reports
const REP = ['admin', 'accountant'];
function summary(id) {
  const pay = q("select method, sum(amount) a from payments where day_id=? group by method", id), sum = k => q(`select sum(amount) a from logs where day_id=? and type=?`, id, k)[0].a || 0;
  const orders = q("select * from orders where day_id=? and status='paid'", id).map(o => totals(o)), sales = orders.reduce((a, t) => a + t.total, 0);
  return { sales, orders: orders.length, vat: orders.reduce((a, t) => a + t.vat, 0), service: orders.reduce((a, t) => a + t.sc, 0), consumption: orders.reduce((a, t) => a + t.cn, 0), discount: sum('discount'), voids: sum('void'), comp: sum('comp'), expenses: q('select sum(amount) a from expenses where day_id=?', id)[0].a || 0, byMethod: pay, pending: q("select count(*) c from orders where status in('open','billed') and day_id=?", id)[0].c, debt: q('select sum(amount-paid) a from debtors')[0].a || 0, lowStock: q('select name,qty,reorder from products where qty<=reorder and reorder>0') };
}
app.get('/api/dashboard', wrap(REP, req => summary(+req.query.day || day().id)));
app.get('/api/reports/:type', wrap(REP, req => {
  const id = +req.query.day || day().id, t = req.params.type, L = k => q('select ts Time, detail Detail, amount Amount, user User from logs where day_id=? and type=?', id, k);
  if (t === 'daily') return { summary: summary(id) };
  if (t === 'sales') return { rows: q("select i.name Item, sum(i.qty) Qty, sum(i.price*i.qty) Sales, sum((i.price-i.cost)*i.qty) Profit from items i join orders o on o.id=i.order_id where o.day_id=? and o.status='paid' and i.status='ok' group by i.name order by Sales desc", id) };
  if (t === 'discount') return { rows: L('discount') }; if (t === 'void') return { rows: L('void') }; if (t === 'storedelete') return { rows: L('store_delete') }; if (t === 'comp') return { rows: L('comp') };
  if (t === 'flow') return { rows: [...q("select ts Time, 'Inflow' Type, method Method, kind Detail, amount Amount, user User from payments where day_id=?", id), ...q("select ts Time, 'Outflow' Type, 'cash' Method, title Detail, amount Amount, user User from expenses where day_id=?", id)].sort((a, b) => a.Time < b.Time ? -1 : 1) };
  if (t === 'debtors') return { rows: q('select ts Date, name Name, amount Amount, paid Paid, amount-paid Balance from debtors order by ts desc') };
  if (t === 'vat') return { rows: q("select id Order_No, table_no [Table] from orders where day_id=? and status='paid'", id).map(o => { const x = totals(one('select * from orders where id=?', o.Order_No)); return { ...o, Sub_Total: x.sub - x.disc, VAT: x.vat, Service: x.sc, Consumption: x.cn }; }) };
  throw new Error('Unknown report');
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));
app.use((err, req, res, next) => res.status(400).json({ error: err.message }));
app.listen(process.env.PORT || 3000, () => console.log('POS running'));
