require("dotenv").config();

const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DB_FILE = path.join(__dirname, "data", "restaurant.db");

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`; }
function money(n) { return Number(Number(n || 0).toFixed(2)); }
function safeText(v, max = 500) { return String(v ?? "").trim().slice(0, max); }

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('OWNER','MANAGER','WAITER','CASHIER','KITCHEN','CA')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  qr_token TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 5,
  veg INTEGER NOT NULL DEFAULT 1,
  image_url TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS item_customizations (
  id TEXT PRIMARY KEY,
  menu_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  extra_price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(menu_item_id) REFERENCES menu_items(id)
);

CREATE TABLE IF NOT EXISTS table_sessions (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','BILLING','CLOSED','CANCELLED')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY(table_id) REFERENCES restaurant_tables(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no INTEGER UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('NEW','ACCEPTED','PREPARING','READY','SERVED','CANCELLED')),
  source TEXT NOT NULL DEFAULT 'QR',
  customer_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES table_sessions(id),
  FOREIGN KEY(table_id) REFERENCES restaurant_tables(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  menu_item_id TEXT,
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  gst_rate REAL NOT NULL,
  customization TEXT,
  line_total REAL NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_at TEXT NOT NULL,
  reference TEXT,
  FOREIGN KEY(session_id) REFERENCES table_sessions(id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_no TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  subtotal REAL NOT NULL,
  discount REAL NOT NULL,
  taxable_value REAL NOT NULL,
  cgst REAL NOT NULL,
  sgst REAL NOT NULL,
  igst REAL NOT NULL,
  round_off REAL NOT NULL,
  total REAL NOT NULL,
  customer_name TEXT,
  customer_gstin TEXT,
  place_of_supply TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES table_sessions(id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  rate REAL NOT NULL,
  taxable_value REAL NOT NULL,
  gst_rate REAL NOT NULL,
  cgst REAL NOT NULL,
  sgst REAL NOT NULL,
  igst REAL NOT NULL,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id)
);

CREATE TABLE IF NOT EXISTS custom_bill_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  rate REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES table_sessions(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  gst_amount REAL NOT NULL DEFAULT 0,
  vendor TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  actor TEXT NOT NULL,
  role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
`);

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

function seed() {
  const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (!userCount) {
    const ins = db.prepare("INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)");
    const created = now();
    ins.run(id("usr"), process.env.ADMIN_USER || "admin", process.env.ADMIN_PASSWORD || "ChangeMe123!", "OWNER", created);
    ins.run(id("usr"), "manager", "Manager123!", "MANAGER", created);
    ins.run(id("usr"), "waiter", "Waiter123!", "WAITER", created);
    ins.run(id("usr"), "cashier", "Cashier123!", "CASHIER", created);
    ins.run(id("usr"), "kitchen", "Kitchen123!", "KITCHEN", created);
    ins.run(id("usr"), "ca", "CA123456!", "CA", created);
  }

  const settings = {
    restaurant_name: process.env.RESTAURANT_NAME || "Royal Bites",
    tagline: "Fresh food. Great taste.",
    phone: "+91 98765 43210",
    address: "Maharashtra, India",
    gstin: process.env.GSTIN || "27ABCDE1234F1Z5",
    state: process.env.STATE || "MAHARASHTRA",
    state_code: process.env.STATE_CODE || "27",
    default_gst_rate: "5"
  };
  for (const [k, v] of Object.entries(settings)) {
    if (!getSetting(k)) setSetting(k, v);
  }

  if (db.prepare("SELECT COUNT(*) c FROM restaurant_tables").get().c === 0) {
    const ins = db.prepare("INSERT INTO restaurant_tables(id,name,qr_token) VALUES(?,?,?)");
    for (let i = 1; i <= 12; i++) ins.run(`table_${i}`, `Table ${i}`, crypto.randomUUID());
  }

  if (db.prepare("SELECT COUNT(*) c FROM categories").get().c === 0) {
    const cats = [
      ["cat_starters","Starters",1],
      ["cat_main","Main Course",2],
      ["cat_breads","Breads",3],
      ["cat_bev","Beverages",4],
      ["cat_dessert","Desserts",5]
    ];
    db.prepare("INSERT INTO categories(id,name,sort_order) VALUES(?,?,?)").all;
    const stmt = db.prepare("INSERT INTO categories(id,name,sort_order) VALUES(?,?,?)");
    cats.forEach(c => stmt.run(...c));

    const item = db.prepare(`INSERT INTO menu_items
      (id,category_id,name,description,price,gst_rate,veg,image_url)
      VALUES(?,?,?,?,?,?,?,?)`);
    item.run("item_paneer","cat_starters","Paneer Tikka","Grilled cottage cheese with mint chutney.",220,5,1,"/images/paneer-tikka.svg");
    item.run("item_chicken","cat_starters","Chicken 65","Crispy spicy fried chicken.",260,5,0,"/images/chicken-65.svg");
    item.run("item_manchurian","cat_starters","Veg Manchurian","Crispy vegetable balls in a savory sauce.",200,5,1,"/images/manchurian.svg");
    item.run("item_biryani","cat_main","Veg Biryani","Fragrant basmati rice with vegetables and spices.",240,5,1,"/images/biryani.svg");
    item.run("item_paneerbutter","cat_main","Paneer Butter Masala","Paneer in creamy tomato gravy.",260,5,1,"/images/paneer-butter.svg");
    item.run("item_roti","cat_breads","Masala Roti","Soft Indian flatbread with spices.",40,5,1,"/images/roti.svg");
    item.run("item_coffee","cat_bev","Cold Coffee","Chilled creamy coffee.",140,5,1,"/images/coffee.svg");
    item.run("item_ice","cat_dessert","Vanilla Ice Cream","Classic vanilla scoop.",120,5,1,"/images/icecream.svg");

    const add = db.prepare("INSERT INTO item_customizations(id,menu_item_id,name,extra_price) VALUES(?,?,?,?)");
    add.run(id("cus"),"item_paneer","Extra Cheese",30);
    add.run(id("cus"),"item_paneer","Extra Spicy",10);
    add.run(id("cus"),"item_roti","Extra Butter",15);
    add.run(id("cus"),"item_coffee","Extra Ice Cream",40);
  }
}
seed();

function audit(actor, role, action, entityType, entityId, details = {}) {
  db.prepare(`INSERT INTO audit_logs(id,user_id,actor,role,action,entity_type,entity_id,details,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    id("audit"), null, actor || "SYSTEM", role || "", action, entityType || "", entityId || "", JSON.stringify(details), now()
  );
}

function requireStaff(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Login required." });
  next();
}
function requireRole(roles) {
  return (req,res,next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) return res.status(403).json({error:"Permission denied."});
    next();
  };
}

function getOrCreateSession(tableId) {
  const table = db.prepare("SELECT * FROM restaurant_tables WHERE id=? AND active=1").get(tableId);
  if (!table) throw new Error("Table not found");
  let sessionRow = db.prepare("SELECT * FROM table_sessions WHERE table_id=? AND status IN ('ACTIVE','BILLING') ORDER BY opened_at DESC LIMIT 1").get(tableId);
  if (!sessionRow) {
    const sid = id("ses");
    db.prepare("INSERT INTO table_sessions(id,table_id,status,opened_at) VALUES(?,?,?,?)").run(sid,tableId,"ACTIVE",now());
    sessionRow = db.prepare("SELECT * FROM table_sessions WHERE id=?").get(sid);
    audit("CUSTOMER","CUSTOMER","TABLE_SESSION_OPENED","TABLE",tableId,{sessionId:sid});
  }
  return sessionRow;
}

function calculateOrderTotals(sessionId) {
  const items = db.prepare(`
    SELECT oi.*, o.status FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    WHERE o.session_id=? AND o.status <> 'CANCELLED'
  `).all(sessionId);
  const custom = db.prepare("SELECT * FROM custom_bill_items WHERE session_id=?").all(sessionId);
  let subtotal = 0;
  const groups = {};
  for (const x of items) {
    subtotal += x.line_total;
    const key = `${x.item_name}|${x.gst_rate}`;
    if (!groups[key]) groups[key] = {name:x.item_name, quantity:0, rate:x.unit_price, taxable:0, gstRate:x.gst_rate};
    groups[key].quantity += x.quantity;
    groups[key].taxable += x.line_total;
  }
  for (const x of custom) {
    const line = money(x.quantity * x.rate);
    subtotal += line;
    const key = `${x.name}|${x.gst_rate}`;
    if (!groups[key]) groups[key] = {name:x.name, quantity:0, rate:x.rate, taxable:0, gstRate:x.gst_rate};
    groups[key].quantity += x.quantity;
    groups[key].taxable += line;
  }
  return { subtotal:money(subtotal), groups:Object.values(groups) };
}

function gstBreakdown(groups, discount=0, placeOfSupply="") {
  const stateCode = getSetting("state_code","27");
  const sameState = !placeOfSupply || String(placeOfSupply).trim().toUpperCase() === getSetting("state","MAHARASHTRA").toUpperCase() || String(placeOfSupply).trim() === stateCode;
  const taxableBefore = groups.reduce((s,g)=>s+g.taxable,0);
  const discountRatio = taxableBefore > 0 ? Math.max(0, Math.min(1, discount/taxableBefore)) : 0;
  let cgst=0, sgst=0, igst=0;
  const invoiceItems = groups.map(g => {
    const taxable = money(g.taxable * (1-discountRatio));
    const tax = money(taxable * g.gstRate / 100);
    const c = sameState ? money(tax/2) : 0;
    const s = sameState ? money(tax/2) : 0;
    const i = sameState ? 0 : tax;
    if (sameState) { cgst += c; sgst += s; } else igst += i;
    return {...g,taxable,cgst:c,sgst:s,igst:i};
  });
  return {invoiceItems, taxableValue:money(invoiceItems.reduce((s,x)=>s+x.taxable,0)),cgst:money(cgst),sgst:money(sgst),igst:money(igst)};
}

app.get("/api/public/menu", (req,res)=>{
  const categories = db.prepare(`
    SELECT c.id category_id,c.name category_name,c.sort_order,
           i.id item_id,i.name item_name,i.description,i.price,i.gst_rate,i.veg,i.image_url
    FROM categories c JOIN menu_items i ON i.category_id=c.id
    WHERE c.active=1 AND i.active=1 AND i.available=1
    ORDER BY c.sort_order,i.name
  `).all();
  const out = {};
  for (const r of categories) {
    if (!out[r.category_id]) out[r.category_id] = {id:r.category_id,name:r.category_name,items:[]};
    out[r.category_id].items.push({
      id:r.item_id,name:r.item_name,description:r.description,price:r.price,gstRate:r.gst_rate,veg:!!r.veg,imageUrl:r.image_url,
      customizations: db.prepare("SELECT id,name,extra_price extraPrice FROM item_customizations WHERE menu_item_id=? AND active=1").all(r.item_id)
    });
  }
  res.json({restaurant:{
    name:getSetting("restaurant_name"),tagline:getSetting("tagline"),phone:getSetting("phone"),
    address:getSetting("address"),gstin:getSetting("gstin")
  },categories:Object.values(out)});
});

app.get("/api/public/table/:token", (req,res)=>{
  const table = db.prepare("SELECT id,name FROM restaurant_tables WHERE qr_token=? AND active=1").get(req.params.token);
  if (!table) return res.status(404).json({error:"Invalid table QR"});
  const sessionRow = getOrCreateSession(table.id);
  res.json({table,sessionId:sessionRow.id});
});

app.post("/api/public/orders", (req,res)=>{
  try {
    const {tableToken,items,note} = req.body;
    if (!tableToken || !Array.isArray(items) || !items.length) return res.status(400).json({error:"Add at least one item."});
    const table = db.prepare("SELECT * FROM restaurant_tables WHERE qr_token=? AND active=1").get(tableToken);
    if (!table) return res.status(404).json({error:"Invalid table QR"});
    const sessionRow = getOrCreateSession(table.id);
    if (sessionRow.status !== "ACTIVE") return res.status(409).json({error:"This table is being closed. Scan again for a new session."});

    const orderNo = db.prepare("SELECT COALESCE(MAX(order_no),1000)+1 n FROM orders").get().n;
    const orderId = id("ord");
    const created = now();

    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO orders(id,order_no,session_id,table_id,status,source,customer_note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(orderId,orderNo,sessionRow.id,table.id,"NEW","QR",safeText(note,1000),created,created);
      const ins = db.prepare(`INSERT INTO order_items(id,order_id,menu_item_id,item_name,quantity,unit_price,gst_rate,customization,line_total)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const x of items) {
        const menuItem = db.prepare("SELECT * FROM menu_items WHERE id=? AND active=1 AND available=1").get(x.menuItemId);
        if (!menuItem) throw new Error(`Item unavailable: ${x.menuItemId}`);
        const qty = Math.max(1, Math.min(50, Number(x.quantity || 1)));
        const selected = Array.isArray(x.customizations) ? x.customizations : [];
        let extra = 0;
        const names = [];
        for (const cid of selected) {
          const c = db.prepare("SELECT * FROM item_customizations WHERE id=? AND menu_item_id=? AND active=1").get(cid,menuItem.id);
          if (c) { extra += c.extra_price; names.push(c.name); }
        }
        const unit = money(menuItem.price + extra);
        ins.run(id("oi"),orderId,menuItem.id,menuItem.name,qty,unit,menuItem.gst_rate,names.join(", "),money(unit*qty));
      }
    });
    tx();
    audit("CUSTOMER","CUSTOMER","ORDER_CREATED","ORDER",orderId,{orderNo,tableId:table.id});
    res.status(201).json({ok:true,orderId,orderNo,table:table.name});
  } catch (e) {
    res.status(400).json({error:e.message});
  }
});

app.get("/api/public/session/:sessionId", (req,res)=>{
  const sessionRow = db.prepare("SELECT s.*,t.name table_name FROM table_sessions s JOIN restaurant_tables t ON t.id=s.table_id WHERE s.id=?").get(req.params.sessionId);
  if (!sessionRow) return res.status(404).json({error:"Session not found"});
  const orders = db.prepare("SELECT * FROM orders WHERE session_id=? ORDER BY created_at").all(req.params.sessionId);
  for (const o of orders) o.items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(o.id);
  const totals = calculateOrderTotals(req.params.sessionId);
  res.json({session:sessionRow,orders,totals});
});

app.post("/api/login",(req,res)=>{
  const {username,password} = req.body;
  const u = db.prepare("SELECT id,username,role FROM users WHERE username=? AND password=? AND active=1").get(safeText(username,100),String(password||""));
  if (!u) return res.status(401).json({error:"Invalid username or password"});
  req.session.user = u;
  audit(u.username,u.role,"LOGIN","USER",u.id);
  res.json({user:u});
});
app.post("/api/logout",(req,res)=>{ if(req.session.user) audit(req.session.user.username,req.session.user.role,"LOGOUT","USER",req.session.user.id); req.session.destroy(()=>res.json({ok:true})); });
app.get("/api/me",(req,res)=>res.json({user:req.session.user||null}));

app.get("/api/staff/orders",requireRole(["OWNER","MANAGER","WAITER","KITCHEN","CASHIER"]), (req,res)=>{
  const orders = db.prepare(`
    SELECT o.*,t.name table_name FROM orders o JOIN restaurant_tables t ON t.id=o.table_id
    WHERE o.status <> 'CANCELLED' ORDER BY CASE o.status WHEN 'NEW' THEN 1 WHEN 'ACCEPTED' THEN 2 WHEN 'PREPARING' THEN 3 WHEN 'READY' THEN 4 ELSE 5 END, o.created_at DESC LIMIT 200
  `).all();
  for (const o of orders) o.items=db.prepare("SELECT * FROM order_items WHERE order_id=?").all(o.id);
  res.json(orders);
});

app.patch("/api/staff/orders/:id/status",requireRole(["OWNER","MANAGER","WAITER","KITCHEN"]), (req,res)=>{
  const allowed=["NEW","ACCEPTED","PREPARING","READY","SERVED","CANCELLED"];
  if (!allowed.includes(req.body.status)) return res.status(400).json({error:"Invalid status"});
  const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!o)return res.status(404).json({error:"Order not found"});
  db.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=?").run(req.body.status,now(),o.id);
  audit(req.session.user.username,req.session.user.role,"ORDER_STATUS_CHANGED","ORDER",o.id,{status:req.body.status});
  res.json({ok:true});
});

app.get("/api/staff/tables",requireRole(["OWNER","MANAGER","WAITER","CASHIER","CA"]), (req,res)=>{
  const tables=db.prepare("SELECT * FROM restaurant_tables WHERE active=1 ORDER BY name").all();
  for(const t of tables){
    t.session=db.prepare("SELECT * FROM table_sessions WHERE table_id=? AND status IN ('ACTIVE','BILLING') ORDER BY opened_at DESC LIMIT 1").get(t.id)||null;
    if(t.session)t.total=calculateOrderTotals(t.session.id).subtotal; else t.total=0;
  }
  res.json(tables);
});

app.get("/api/billing/:sessionId",requireRole(["OWNER","MANAGER","CASHIER","CA"]), (req,res)=>{
  const s=db.prepare("SELECT s.*,t.name table_name FROM table_sessions s JOIN restaurant_tables t ON t.id=s.table_id WHERE s.id=?").get(req.params.sessionId);
  if(!s)return res.status(404).json({error:"Session not found"});
  const totals=calculateOrderTotals(s.id);
  const custom=db.prepare("SELECT * FROM custom_bill_items WHERE session_id=?").all(s.id);
  const invoice=db.prepare("SELECT * FROM invoices WHERE session_id=? ORDER BY created_at DESC LIMIT 1").get(s.id)||null;
  res.json({session:s,totals,custom,invoice,settings:{
    name:getSetting("restaurant_name"),gstin:getSetting("gstin"),state:getSetting("state"),stateCode:getSetting("state_code"),address:getSetting("address")
  }});
});

app.post("/api/billing/:sessionId/custom-item",requireRole(["OWNER","MANAGER","CASHIER"]), (req,res)=>{
  const {name,quantity,rate,gstRate}=req.body;
  if(!safeText(name,120)||Number(rate)<0)return res.status(400).json({error:"Valid custom item name and rate required"});
  const s=db.prepare("SELECT * FROM table_sessions WHERE id=? AND status IN ('ACTIVE','BILLING')").get(req.params.sessionId);
  if(!s)return res.status(404).json({error:"Active session not found"});
  const itemId=id("custom");
  db.prepare("INSERT INTO custom_bill_items(id,session_id,name,quantity,rate,gst_rate,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(itemId,s.id,safeText(name,120),Math.max(1,Number(quantity||1)),Number(rate),Number(gstRate||5),now());
  audit(req.session.user.username,req.session.user.role,"CUSTOM_BILL_ITEM_ADDED","SESSION",s.id,{itemId,name});
  res.json({ok:true});
});

app.delete("/api/billing/custom-item/:id",requireRole(["OWNER","MANAGER","CASHIER"]), (req,res)=>{
  const x=db.prepare("SELECT * FROM custom_bill_items WHERE id=?").get(req.params.id);
  if(!x)return res.status(404).json({error:"Item not found"});
  db.prepare("DELETE FROM custom_bill_items WHERE id=?").run(x.id);
  audit(req.session.user.username,req.session.user.role,"CUSTOM_BILL_ITEM_DELETED","CUSTOM_ITEM",x.id,{name:x.name});
  res.json({ok:true});
});

app.post("/api/billing/:sessionId/checkout",requireRole(["OWNER","MANAGER","CASHIER"]), (req,res)=>{
  try {
    const s=db.prepare("SELECT * FROM table_sessions WHERE id=? AND status IN ('ACTIVE','BILLING')").get(req.params.sessionId);
    if(!s)return res.status(404).json({error:"Active session not found"});
    const discount=Math.max(0,Number(req.body.discount||0));
    const placeOfSupply=safeText(req.body.placeOfSupply||getSetting("state"),100);
    const customerName=safeText(req.body.customerName,120);
    const customerGstin=safeText(req.body.customerGstin,20);
    const paymentMode=safeText(req.body.paymentMode||"CASH",30);
    const totals=calculateOrderTotals(s.id);
    const breakdown=gstBreakdown(totals.groups,discount,placeOfSupply);
    const totalBeforeRound=money(breakdown.taxableValue+breakdown.cgst+breakdown.sgst+breakdown.igst);
    const rounded=Math.round(totalBeforeRound);
    const roundOff=money(rounded-totalBeforeRound);
    const total=money(rounded);

    const invoiceId=id("inv");
    const invoiceNo=`INV-${new Date().getFullYear()}-${String(db.prepare("SELECT COUNT(*) c FROM invoices").get().c+1).padStart(6,"0")}`;
    const tx=db.transaction(()=>{
      db.prepare("INSERT INTO invoices(id,invoice_no,session_id,table_id,subtotal,discount,taxable_value,cgst,sgst,igst,round_off,total,customer_name,customer_gstin,place_of_supply,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(invoiceId,invoiceNo,s.id,s.table_id,totals.subtotal,discount,breakdown.taxableValue,breakdown.cgst,breakdown.sgst,breakdown.igst,roundOff,total,customerName,customerGstin,placeOfSupply,now());
      const ii=db.prepare("INSERT INTO invoice_items(id,invoice_id,item_name,quantity,rate,taxable_value,gst_rate,cgst,sgst,igst) VALUES(?,?,?,?,?,?,?,?,?,?)");
      breakdown.invoiceItems.forEach(x=>ii.run(id("ii"),invoiceId,x.name,x.quantity,x.rate,x.taxable,x.gstRate,x.cgst,x.sgst,x.igst));
      db.prepare("INSERT INTO payments(id,session_id,payment_mode,amount,paid_at,reference) VALUES(?,?,?,?,?,?)")
        .run(id("pay"),s.id,paymentMode,total,now(),safeText(req.body.reference,100));
      db.prepare("UPDATE table_sessions SET status='CLOSED',closed_at=? WHERE id=?").run(now(),s.id);
    });
    tx();
    audit(req.session.user.username,req.session.user.role,"BILL_GENERATED","INVOICE",invoiceId,{invoiceNo,total,sessionId:s.id});
    audit(req.session.user.username,req.session.user.role,"PAYMENT_COMPLETED","SESSION",s.id,{amount:total,paymentMode});
    res.json({ok:true,invoiceId,invoiceNo,total});
  } catch(e){ res.status(400).json({error:e.message}); }
});

app.get("/invoice/:id",requireRole(["OWNER","MANAGER","CASHIER","CA"]), (req,res)=>{
  const inv=db.prepare(`SELECT i.*,t.name table_name FROM invoices i JOIN restaurant_tables t ON t.id=i.table_id WHERE i.id=?`).get(req.params.id);
  if(!inv)return res.status(404).send("Invoice not found");
  const items=db.prepare("SELECT * FROM invoice_items WHERE invoice_id=?").all(inv.id);
  const settings={name:getSetting("restaurant_name"),gstin:getSetting("gstin"),address:getSetting("address"),phone:getSetting("phone")};
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${inv.invoice_no}</title><style>
  body{font-family:Arial;max-width:800px;margin:20px auto;padding:20px;color:#111}h1{margin-bottom:2px}.muted{color:#666}
  table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #ddd;padding:9px;text-align:right}th:first-child,td:first-child{text-align:left}
  .total{font-size:20px;font-weight:bold}.actions{margin-bottom:20px}@media print{.actions{display:none}}
  </style></head><body><div class="actions"><button onclick="print()">Print / Save PDF</button></div>
  <h1>${settings.name}</h1><div>${settings.address} · ${settings.phone}</div><div>GSTIN: ${settings.gstin}</div>
  <hr><h2>TAX INVOICE</h2><div>Invoice: ${inv.invoice_no} · Date: ${inv.created_at} · ${inv.table_name}</div>
  ${inv.customer_name?`<div>Customer: ${inv.customer_name}</div>`:""}
  ${inv.customer_gstin?`<div>Customer GSTIN: ${inv.customer_gstin}</div>`:""}
  <table><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST</th><th>Total</th></tr>
  ${items.map(x=>`<tr><td>${x.item_name}</td><td>${x.quantity}</td><td>₹${x.rate.toFixed(2)}</td><td>₹${x.taxable_value.toFixed(2)}</td><td>₹${(x.cgst+x.sgst+x.igst).toFixed(2)}</td><td>₹${(x.taxable_value+x.cgst+x.sgst+x.igst).toFixed(2)}</td></tr>`).join("")}
  </table><p>Subtotal: ₹${inv.subtotal.toFixed(2)}</p><p>Discount: ₹${inv.discount.toFixed(2)}</p>
  <p>Taxable: ₹${inv.taxable_value.toFixed(2)}</p><p>CGST: ₹${inv.cgst.toFixed(2)} · SGST: ₹${inv.sgst.toFixed(2)} · IGST: ₹${inv.igst.toFixed(2)}</p>
  <p>Round-off: ₹${inv.round_off.toFixed(2)}</p><p class="total">TOTAL: ₹${inv.total.toFixed(2)}</p>
  </body></html>`);
});

app.get("/api/reports/summary",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  const from=req.query.from || new Date().toISOString().slice(0,10);
  const to=req.query.to || from;
  const sales=db.prepare(`SELECT COALESCE(SUM(total),0) sales,COALESCE(SUM(cgst+sgst+igst),0) gst,COUNT(*) invoices FROM invoices WHERE date(created_at) BETWEEN ? AND ?`).get(from,to);
  const orders=db.prepare(`SELECT COUNT(*) c FROM orders WHERE date(created_at) BETWEEN ? AND ? AND status<>'CANCELLED'`).get(from,to).c;
  const payments=db.prepare(`SELECT payment_mode,COALESCE(SUM(amount),0) amount,COUNT(*) count FROM payments WHERE date(paid_at) BETWEEN ? AND ? GROUP BY payment_mode ORDER BY amount DESC`).all(from,to);
  const topItems=db.prepare(`SELECT item_name,SUM(quantity) quantity,SUM(line_total) sales FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE date(o.created_at) BETWEEN ? AND ? AND o.status<>'CANCELLED' GROUP BY item_name ORDER BY sales DESC LIMIT 10`).all(from,to);
  const gst=db.prepare(`SELECT COALESCE(SUM(taxable_value),0) taxable,COALESCE(SUM(cgst),0) cgst,COALESCE(SUM(sgst),0) sgst,COALESCE(SUM(igst),0) igst FROM invoices WHERE date(created_at) BETWEEN ? AND ?`).get(from,to);
  const expenses=db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM expenses WHERE expense_date BETWEEN ? AND ?").get(from,to).amount;
  res.json({from,to,sales,orders,payments,topItems,gst,expenses,profit:money(sales.sales-expenses)});
});

app.get("/api/reports/audit",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  const rows=db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500").all();
  res.json(rows);
});

app.post("/api/expenses",requireRole(["OWNER","MANAGER"]), (req,res)=>{
  const x={date:safeText(req.body.date,20)||new Date().toISOString().slice(0,10),category:safeText(req.body.category,80),description:safeText(req.body.description,300),amount:Number(req.body.amount||0),gstAmount:Number(req.body.gstAmount||0),vendor:safeText(req.body.vendor,120)};
  if(!x.category||x.amount<0)return res.status(400).json({error:"Category and valid amount required"});
  const eid=id("exp");
  db.prepare("INSERT INTO expenses(id,expense_date,category,description,amount,gst_amount,vendor,created_at) VALUES(?,?,?,?,?,?,?,?)").run(eid,x.date,x.category,x.description,x.amount,x.gstAmount,x.vendor,now());
  audit(req.session.user.username,req.session.user.role,"EXPENSE_ADDED","EXPENSE",eid,x);
  res.json({ok:true,id:eid});
});

function csvEscape(v){ const s=String(v??""); return `"${s.replace(/"/g,'""')}"`; }
function sendCsv(res,filename,headers,rows){
  const out=[headers.map(csvEscape).join(","),...rows.map(r=>r.map(csvEscape).join(","))].join("\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8"); res.setHeader("Content-Disposition",`attachment; filename="${filename}"`); res.send("\ufeff"+out);
}

app.get("/api/ca/export/sales",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  const from=req.query.from||"2000-01-01",to=req.query.to||"2999-12-31";
  const rows=db.prepare(`SELECT i.invoice_no,date(i.created_at) date,t.name table_name,i.subtotal,i.discount,i.taxable_value,i.cgst,i.sgst,i.igst,i.total,i.customer_name,i.customer_gstin,i.place_of_supply FROM invoices i JOIN restaurant_tables t ON t.id=i.table_id WHERE date(i.created_at) BETWEEN ? AND ? ORDER BY i.created_at`).all(from,to);
  sendCsv(res,"sales-register.csv",Object.keys(rows[0]||{invoice_no:"",date:""}),rows.map(x=>Object.values(x)));
});
app.get("/api/ca/export/gst",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  const from=req.query.from||"2000-01-01",to=req.query.to||"2999-12-31";
  const rows=db.prepare("SELECT invoice_no,date(created_at) date,taxable_value,cgst,sgst,igst,total FROM invoices WHERE date(created_at) BETWEEN ? AND ? ORDER BY created_at").all(from,to);
  sendCsv(res,"gst-summary.csv",["invoice_no","date","taxable_value","cgst","sgst","igst","total"],rows.map(x=>Object.values(x)));
});
app.get("/api/ca/export/expenses",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  const from=req.query.from||"2000-01-01",to=req.query.to||"2999-12-31";
  const rows=db.prepare("SELECT expense_date,category,description,amount,gst_amount,vendor FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date").all(from,to);
  sendCsv(res,"expenses.csv",["date","category","description","amount","gst_amount","vendor"],rows.map(x=>Object.values(x)));
});
app.get("/api/ca/export/audit",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  const rows=db.prepare("SELECT created_at,actor,role,action,entity_type,entity_id,details FROM audit_logs ORDER BY created_at").all();
  sendCsv(res,"audit-log.csv",["created_at","actor","role","action","entity_type","entity_id","details"],rows.map(x=>Object.values(x)));
});

app.get("/api/admin/settings",requireRole(["OWNER","MANAGER","CA"]), (req,res)=>{
  res.json({
    restaurant_name:getSetting("restaurant_name"),tagline:getSetting("tagline"),phone:getSetting("phone"),
    address:getSetting("address"),gstin:getSetting("gstin"),state:getSetting("state"),state_code:getSetting("state_code"),
    default_gst_rate:getSetting("default_gst_rate")
  });
});
app.put("/api/admin/settings",requireRole(["OWNER","MANAGER"]), (req,res)=>{
  const keys=["restaurant_name","tagline","phone","address","gstin","state","state_code","default_gst_rate"];
  for(const k of keys) if(req.body[k]!==undefined)setSetting(k,safeText(req.body[k],150));
  audit(req.session.user.username,req.session.user.role,"SETTINGS_UPDATED","SETTINGS","restaurant");
  res.json({ok:true});
});

app.get("/api/admin/tables",requireRole(["OWNER","MANAGER"]),async(req,res)=>{
  const tables=db.prepare("SELECT * FROM restaurant_tables WHERE active=1 ORDER BY name").all();
  for(const t of tables)t.url=`${APP_URL}/menu.html?table=${encodeURIComponent(t.qr_token)}`;
  res.json(tables);
});
app.get("/api/admin/tables/:id/qr",requireRole(["OWNER","MANAGER"]),async(req,res)=>{
  const t=db.prepare("SELECT * FROM restaurant_tables WHERE id=?").get(req.params.id);
  if(!t)return res.status(404).end();
  const png=await QRCode.toBuffer(`${APP_URL}/menu.html?table=${encodeURIComponent(t.qr_token)}`,{width:900,margin:3,errorCorrectionLevel:"H"});
  res.type("png").send(png);
});

app.get("/api/health",(req,res)=>res.json({ok:true,time:now()}));

app.get("/",(req,res)=>res.redirect("/menu.html"));
app.get("/staff",(req,res)=>res.sendFile(path.join(__dirname,"public","staff.html")));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));

app.listen(PORT,()=>console.log(`Restaurant QR POS running at ${APP_URL}`));
