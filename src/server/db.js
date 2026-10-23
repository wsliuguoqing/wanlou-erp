'use strict';
/**
 * 数据库层：schema 定义 + 初始化种子数据
 * 使用 Node 22 内置 node:sqlite，无需安装任何依赖
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.WL_DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'wanlou.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                -- sales|purchaser|finance|manager|admin
  phone TEXT,
  status INTEGER NOT NULL DEFAULT 1, -- 1启用 0停用
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role, permission)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  address TEXT,
  keeper TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  address TEXT,
  salesperson_id INTEGER,
  level TEXT DEFAULT 'C',
  remark TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  address TEXT,
  remark TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 物料：type = normal 普通 | master 母卷 | sub 子卷 | waste 料头 | product 成品
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  spec TEXT,
  unit TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal',
  barcode TEXT,
  base_width REAL,          -- 母卷原始宽度 mm
  min_waste REAL DEFAULT 10,-- 料头阈值 mm
  cut_fee REAL DEFAULT 0,   -- 分切费 元/卷
  parent_id INTEGER,        -- 子卷指向母卷
  safety_stock REAL DEFAULT 0,
  cost REAL DEFAULT 0,      -- 移动加权平均成本
  batch_manage INTEGER DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 普通/子卷/成品的库存数量（按物料+仓库）
CREATE TABLE IF NOT EXISTS inventory (
  material_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (material_id, warehouse_id)
);

-- 母卷：每一支物理卷单独一行，记录剩余宽度
CREATE TABLE IF NOT EXISTS rolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  batch_no TEXT,
  width_total REAL NOT NULL,
  width_used REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,   -- 该支母卷的成本
  status TEXT NOT NULL DEFAULT 'open', -- open | waste(料头) | used
  created_at TEXT NOT NULL
);

-- 单据：出库/入库/销售退货/采购退货/盘点 统一表
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,        -- OUT|IN|SRET|PRET|CHECK
  sn TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL,
  partner_id INTEGER,        -- 客户或供应商 id
  warehouse_id INTEGER NOT NULL,
  contract_sn TEXT,
  salesperson_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|pending|approved|rejected|void
  total_amount REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  pay_status TEXT DEFAULT 'unpaid',     -- unpaid|partial|paid
  invoice_status INTEGER DEFAULT 0,     -- 0未开 1已开 2随货开
  carrier TEXT,
  receiver TEXT,
  receiver_phone TEXT,
  receiver_addr TEXT,
  remark TEXT,
  source_doc_id INTEGER,     -- 退货关联的原单
  created_by INTEGER,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  audited_by INTEGER,
  audited_at TEXT,
  audit_reason TEXT,
  void_reason TEXT
);

CREATE TABLE IF NOT EXISTS doc_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  cost_amount REAL DEFAULT 0,
  cut_width REAL,            -- 母卷分切宽度
  cut_qty REAL,              -- 分切出的卷数
  batch_no TEXT,
  remark TEXT
);

CREATE TABLE IF NOT EXISTS inventory_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  doc_type TEXT,
  doc_sn TEXT,
  qty_change REAL NOT NULL,
  qty_before REAL NOT NULL,
  qty_after REAL NOT NULL,
  cost REAL,
  amount REAL,
  remark TEXT,
  operator_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,       -- receive 收款 | pay 付款
  partner_id INTEGER NOT NULL,
  pay_date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  doc_id INTEGER NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT,
  module TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_docs_type_date ON docs(type, doc_date);
CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
CREATE INDEX IF NOT EXISTS idx_items_doc ON doc_items(doc_id);
CREATE INDEX IF NOT EXISTS idx_logs_mat ON inventory_logs(material_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rolls_mat ON rolls(material_id, warehouse_id, status);
`;

db.exec(SCHEMA);

/* ---------------- 工具 ---------------- */
function now() {
  const d = new Date(Date.now() + 8 * 3600e3); // 统一按东八区存字符串
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function today() { return now().slice(0, 10); }

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pwd, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const test = crypto.scryptSync(pwd, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch { return false; }
}

/* ---------------- 权限定义 ---------------- */
// 每个权限：模块.动作
const ALL_PERMISSIONS = [
  'outbound.view', 'outbound.create', 'outbound.edit', 'outbound.delete', 'outbound.audit', 'outbound.void', 'outbound.invoice',
  'inbound.view', 'inbound.create', 'inbound.edit', 'inbound.delete', 'inbound.audit', 'inbound.void', 'inbound.pay',
  'sret.view', 'sret.create', 'sret.audit', 'sret.void',
  'pret.view', 'pret.create', 'pret.audit', 'pret.void',
  'customer.view', 'customer.create', 'customer.edit', 'customer.delete',
  'supplier.view', 'supplier.create', 'supplier.edit', 'supplier.delete',
  'material.view', 'material.create', 'material.edit', 'material.delete',
  'warehouse.view', 'warehouse.manage',
  'inventory.view', 'inventory.log',
  'check.view', 'check.create', 'check.audit', 'check.void',
  'report.carryover', 'report.summary', 'report.profit',
  'ar.view', 'ap.view',
  'payment.receive', 'payment.pay',
  'cost.view',                 // 查看成本与毛利
  'user.manage', 'log.view', 'setting.manage', 'backup.manage', 'migration.manage'
];

const DEFAULT_ROLE_PERMISSIONS = {
  sales: [
    'outbound.view', 'outbound.create', 'outbound.edit', 'outbound.delete',
    'sret.view', 'sret.create',
    'customer.view', 'customer.create', 'customer.edit',
    'material.view', 'inventory.view', 'inventory.log', 'warehouse.view'
  ],
  purchaser: [
    'inbound.view', 'inbound.create', 'inbound.edit', 'inbound.delete',
    'pret.view', 'pret.create',
    'supplier.view', 'supplier.create', 'supplier.edit',
    'material.view', 'material.create', 'material.edit',
    'inventory.view', 'inventory.log', 'warehouse.view',
    'check.view', 'check.create'
  ],
  finance: [
    'outbound.view', 'outbound.invoice', 'inbound.view', 'inbound.pay',
    'sret.view', 'pret.view',
    'customer.view', 'supplier.view', 'material.view',
    'inventory.view', 'inventory.log', 'warehouse.view',
    'check.view',
    'report.carryover', 'report.summary', 'report.profit',
    'ar.view', 'ap.view', 'payment.receive', 'payment.pay',
    'cost.view'
  ],
  manager: [
    'outbound.view', 'outbound.create', 'outbound.edit', 'outbound.audit', 'outbound.invoice',
    'inbound.view', 'inbound.create', 'inbound.edit', 'inbound.audit', 'inbound.pay',
    'sret.view', 'sret.create', 'sret.audit',
    'pret.view', 'pret.create', 'pret.audit',
    'customer.view', 'customer.create', 'customer.edit',
    'supplier.view', 'supplier.create', 'supplier.edit',
    'material.view', 'material.create', 'material.edit',
    'warehouse.view',
    'inventory.view', 'inventory.log',
    'check.view', 'check.create', 'check.audit',
    'report.carryover', 'report.summary', 'report.profit',
    'ar.view', 'ap.view', 'payment.receive', 'payment.pay',
    'cost.view', 'log.view'
  ],
  admin: ALL_PERMISSIONS
};

/* ---------------- 初始化 ---------------- */
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;

  const ts = now();

  // 角色权限
  const insPerm = db.prepare('INSERT OR IGNORE INTO role_permissions(role, permission, enabled) VALUES (?,?,?)');
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const p of ALL_PERMISSIONS) {
      insPerm.run(role, p, perms.includes(p) ? 1 : 0);
    }
  }

  // 默认超级管理员
  db.prepare('INSERT INTO users(username,password_hash,name,role,phone,status,created_at) VALUES (?,?,?,?,?,1,?)')
    .run('admin', hashPassword('admin123'), '超级管理员', 'admin', '', ts);

  // 默认仓库
  db.prepare('INSERT INTO warehouses(name,address,keeper,status,created_at) VALUES (?,?,?,1,?)')
    .run('主仓库', '', '', ts);

  // 系统设置
  const insSet = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
  insSet.run('company_name', '河南万楼商贸有限公司');
  insSet.run('company_address', '');
  insSet.run('company_phone', '');
  insSet.run('tax_no', '');
  insSet.run('sn_prefix_IN', 'RK');
  insSet.run('sn_prefix_OUT', 'CK');
  insSet.run('sn_prefix_SRET', 'TH');
  insSet.run('sn_prefix_PRET', 'CGTH');
  insSet.run('sn_prefix_CHECK', 'PD');
  insSet.run('min_waste', '10');
  insSet.run('need_approval', '1');
  insSet.run('tax_rate', '13');

  return true;
}

const seeded = seed();

module.exports = {
  db, now, today, hashPassword, verifyPassword,
  ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, DATA_DIR, DB_FILE, seeded
};
