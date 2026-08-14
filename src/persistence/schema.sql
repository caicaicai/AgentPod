-- AgentPod 结构化存储（STORAGE_DRIVER=mysql 时使用）
--
-- ── 设计要点 ────────────────────────────────────────────────────────────
--
--  1. **username 进主键首列**。隔离契约 #4 要求任何读写都带 username；把它放在
--     主键最左边之后，"忘了带 username 的查询"在索引层面就走不通，而不是靠
--     每个调用点自觉。（唯一的例外是分享指针表，理由见 ap_kv 的注释。）
--
--  2. **一张通用 KV 表装下所有"按 id 存一个小 JSON"的东西**（项目、定时任务、
--     作品元信息、分享指针）。这不是偷懒：这几样的读写模式本来就一模一样，
--     而 src/persistence/file-map.js 早就把它抽象成了同一个接口 ——
--     那边一个目录一个集合，这边一个 collection 一个集合，上层一行不用改。
--     真有哪一类长出了自己的查询需求（比如要按某个字段排序分页），
--     再把它拆成独立表，那时候拆是有依据的。
--
--  3. **时间列统一 UTC**（连接上 timezone='Z'）。CST 写入 + UTC 读出会让相对
--     时间显示成"未来"，而那种错只在跨时区部署时才现形。
--
--  4. 正文一律 MEDIUMTEXT（16MB）存 JSON 字符串，不用 MySQL 的 JSON 类型：
--     我们从不在 SQL 里查 JSON 内部，用 JSON 类型只是多一层解析开销，
--     还把"能不能跑"绑死在 MySQL 5.7+ 上。

-- ── 账号 ────────────────────────────────────────────────────────────────
--
-- ⚠️ 只存 scrypt 的派生结果与盐，**不存明文也不存可逆密文**。
-- CONSOLE_USERS 那条路（明文写在环境变量里）在 mysql 驱动下只用于**首次播种**。
CREATE TABLE IF NOT EXISTS `ap_user` (
  `username`      VARCHAR(64)  NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'scrypt 派生结果，hex',
  `salt`          VARCHAR(64)  NOT NULL COMMENT '每个用户独立的随机盐，hex',
  `role`          VARCHAR(16)  NOT NULL DEFAULT 'user' COMMENT 'user | admin',
  `disabled`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '禁用后不能登录，数据保留',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='控制台账号';

-- ── 通用 KV（项目 / 定时任务 / 作品元信息 / 分享指针）────────────────────
--
-- `owner` 就是 username。**分享指针表是唯一 owner='' 的集合** —— 访客手里只有
-- token，服务端必须能不带 username 查到它属于谁，那是这个功能的前提。
-- 它存的只是"token → 谁的哪份作品"这个指向，不含作品任何内容；
-- 权威状态在作品记录自己的 share 字段上（见 src/artifacts/shares.js 文件头）。
CREATE TABLE IF NOT EXISTS `ap_kv` (
  `collection` VARCHAR(32)  NOT NULL COMMENT 'projects | cron | artifacts | shares',
  `owner`      VARCHAR(64)  NOT NULL COMMENT 'username；全局集合为空串',
  `id`         VARCHAR(128) NOT NULL,
  `payload`    MEDIUMTEXT   NOT NULL COMMENT '记录本体（JSON 字符串）',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`collection`, `owner`, `id`),
  -- 定时任务的调度要跨用户找到期的任务，靠这条扫 owner
  KEY `idx_collection_owner` (`collection`, `owner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='按 id 存取的小记录';

-- ── 文档（长期记忆 MEMORY.md）───────────────────────────────────────────
--
-- `scope` 空串 = 个人记忆，否则是 projectId（项目记忆）。与文件版那两条路径
--   users/<u>/memory/MEMORY.md 和 users/<u>/projects/<id>/MEMORY.md 一一对应。
CREATE TABLE IF NOT EXISTS `ap_doc` (
  `username`   VARCHAR(64)  NOT NULL,
  `scope`      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '空串=个人，否则 projectId',
  `kind`       VARCHAR(16)  NOT NULL DEFAULT 'memory',
  `content`    MEDIUMTEXT   NOT NULL,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`, `kind`, `scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='按用户/作用域存的整篇文档';

-- ── 作品的文件正文 ──────────────────────────────────────────────────────
--
-- 一份作品的一个版本 = 若干行。**每版都是完整快照**（不是相对上一版的差量），
-- 所以清理旧版就只是 DELETE 掉那个 version，不必算引用 —— 与文件版
-- `rm -rf v1/` 同一个道理，见 src/artifacts/store.js 文件头。
--
-- 单版总大小由 ARTIFACT_MAX_BYTES 兜着（默认 512KB），MEDIUMTEXT 绰绰有余。
CREATE TABLE IF NOT EXISTS `ap_artifact_file` (
  `username`    VARCHAR(64)  NOT NULL,
  `artifact_id` VARCHAR(64)  NOT NULL,
  `version`     INT          NOT NULL,
  `path`        VARCHAR(255) NOT NULL COMMENT '作品内的相对路径，原样保留',
  `content`     MEDIUMTEXT   NOT NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`, `artifact_id`, `version`, `path`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='作品每一版的文件正文';

-- ── Token 用量台账 ──────────────────────────────────────────────────────
--
-- 一行 = 一次跑完的 run。**只追加，不更新**（一次 run 的用量跑完就定了）。
--
-- ⚠️ 这是唯一一张**故意不以 username 开头建索引**的按人分区表，理由与隔离契约
-- 不冲突：它的读者只有管理员，而管理员问的问题恰恰是跨用户的（"这个月谁在烧
-- token"）。所以两条索引都要有 ——
--   idx_created           跨用户按时间窗扫（管理台的总表）
--   idx_username_created  单个用户的明细（点开某一行时）
-- 少了后一条，看一个人的明细会退化成全表扫。
--
-- 为什么存明细行而不是直接存"每人每天一个累加值"：
--   1. 累加值回答不了"这些 token 花在哪个模型上"，而模型单价差一个数量级；
--   2. UPDATE 累加要么加锁要么用 ON DUPLICATE KEY，并发下都比一条 INSERT 贵；
--   3. 真嫌行多了，按 created_at 删掉旧的即可（DELETE ... WHERE created_at < ?），
--      而累加值一旦压缩过就找不回明细。
--
-- run_id 上有唯一键：重试/重放同一个 run 不会把用量记两遍。
CREATE TABLE IF NOT EXISTS `ap_usage` (
  `id`                BIGINT       NOT NULL AUTO_INCREMENT,
  `username`          VARCHAR(64)  NOT NULL,
  `run_id`            VARCHAR(64)  NOT NULL,
  `source`            VARCHAR(32)  NOT NULL DEFAULT 'web' COMMENT 'web | cron | api | channel',
  `model_id`          VARCHAR(128) NOT NULL DEFAULT '',
  `input_tokens`      BIGINT       NOT NULL DEFAULT 0,
  `output_tokens`     BIGINT       NOT NULL DEFAULT 0,
  `cache_read_tokens` BIGINT       NOT NULL DEFAULT 0 COMMENT '命中缓存读入的 token，计价与 input 不同，单列',
  `duration_ms`       INT          NOT NULL DEFAULT 0,
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_run` (`run_id`),
  KEY `idx_created` (`created_at`),
  KEY `idx_username_created` (`username`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每次 run 的 token 用量（管理台按人汇总用）';

-- ── 会话 ────────────────────────────────────────────────────────────────
-- 会话表早于本文件存在，定义在 src/sessions/schema.sql，由同一个 ensureSchema 一起建。
