
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','leader','member','viewer')),
  unit_ids TEXT NOT NULL DEFAULT '[]',
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  code TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '待规划',
  goal TEXT NOT NULL DEFAULT '',
  budget REAL NOT NULL DEFAULT 0 CHECK(budget >= 0),
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subsystem TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  owner_label TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','review','done')),
  due_date TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_unit_status ON tasks(unit_id,status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subsystem TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_milestones_unit ON milestones(unit_id);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'medium' CHECK(level IN ('critical','medium','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','watch','closed')),
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  owner_label TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_risks_unit_status ON risks(unit_id,status);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subsystem TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 1 CHECK(quantity >= 0),
  unit_price REAL NOT NULL DEFAULT 0 CHECK(unit_price >= 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','ordered','arrived')),
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  owner_label TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_purchases_unit ON purchases(unit_id);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  team_name TEXT NOT NULL DEFAULT '武汉大学 · 珞珈狐战队',
  season TEXT NOT NULL DEFAULT 'RM 2027',
  team_budget REAL NOT NULL DEFAULT 0 CHECK(team_budget >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO settings(id,team_name,season,team_budget) VALUES(1,'武汉大学 · 珞珈狐战队','RM 2027',0);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_logs(id DESC);

INSERT OR IGNORE INTO units(id,name,short_name,code,color,description,stage,goal,budget) VALUES
 ('hero','英雄机器人','英雄','01','#eac094','大弹丸发射、云台与底盘机动、视觉跟踪','待规划','完成系统集成验证',0),
 ('engineer','工程机器人','工程','02','#69c8be','机械臂、抓取、物资运输与可靠性验证','待规划','完成连续作业验收',0),
 ('infantry3','3 号步兵','步兵 3','03','#88acf0','运动控制、装甲识别、自瞄发射','待规划','打通机动自瞄闭环',0),
 ('infantry4','4 号步兵','步兵 4','04','#ba9df4','整车机动、视觉、电控协同','待规划','完成步兵平台联调',0),
 ('aerial','空中机器人','空中','06','#7cc7db','飞控、视觉定位、地面站与安全','待规划','完成可控安全飞行',0),
 ('sentry','哨兵机器人','哨兵','07','#74ddad','定位导航、自瞄、战术决策与整车控制','待规划','实现感知—决策—控制闭环',0),
 ('dart','飞镖系统','飞镖','08','#edb980','发射机构、姿态控制及精度验证','待规划','实现稳定发射与复现',0),
 ('radar','雷达系统','雷达','09','#87c7df','目标检测定位、赛场信息与协同通信','待规划','完成目标信息闭环',0);
