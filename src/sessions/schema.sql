-- 云端 Agent 会话存储
--
-- 设计要点：
--  1. username 进主键与索引首列 —— 任何查询都必须带 username（隔离契约 #4）
--  2. 会话正文按 pi 的 append-only JSONL 逐行存，只追加不重写
--  3. 时间列统一 UTC 写入（写入端 SET time_zone='+00:00' 或用 UTC_TIMESTAMP()），
--     避免 CST 写入 + 按 UTC 读出导致相对时间显示成"未来"

CREATE TABLE IF NOT EXISTS `ap_cloud_session` (
  `username`          VARCHAR(64)  NOT NULL COMMENT '用户名（服务端校验得到，非客户端自称）',
  `session_key`  VARCHAR(128) NOT NULL COMMENT '会话键，默认 main',
  `session_id`   VARCHAR(64)  NOT NULL COMMENT 'pi 生成的 sessionId（UUIDv7）',
  `title`        VARCHAR(255)     NULL COMMENT '会话标题，供列表展示',
  `entry_count`  INT          NOT NULL DEFAULT 0,
  `project_id`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '所属项目，空串=未归入任何项目',
  `pinned`       TINYINT(1)   NOT NULL DEFAULT 0,
  `archived`     TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`, `session_key`),
  KEY `idx_username_updated` (`username`, `updated_at` DESC),
  KEY `idx_username_project` (`username`, `project_id`, `updated_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='云端 agent 会话元数据';

-- 已经建过表的实例执行这三条补列（MySQL 8.0 的 IF NOT EXISTS 不支持 ADD COLUMN，
-- 重复执行会报 1060，可安全忽略）：
--   ALTER TABLE `ap_cloud_session` ADD COLUMN `project_id` VARCHAR(64) NOT NULL DEFAULT '';
--   ALTER TABLE `ap_cloud_session` ADD COLUMN `pinned`   TINYINT(1) NOT NULL DEFAULT 0;
--   ALTER TABLE `ap_cloud_session` ADD COLUMN `archived` TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS `ap_cloud_session_entry` (
  `id`           BIGINT       NOT NULL AUTO_INCREMENT,
  `username`          VARCHAR(64)  NOT NULL,
  `session_key`  VARCHAR(128) NOT NULL,
  `seq`          INT          NOT NULL COMMENT 'JSONL 行序号，从 0 开始',
  `payload`      MEDIUMTEXT   NOT NULL COMMENT 'pi 会话的一行 JSONL',
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_session_seq` (`username`, `session_key`, `seq`),
  KEY `idx_username_session` (`username`, `session_key`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='云端 agent 会话正文（append-only）';

-- 任务台账（定时任务/异步 run 的执行记录）。调度真源在控制面，不在 agent 进程里。
CREATE TABLE IF NOT EXISTS `ap_cloud_task_run` (
  `run_id`          VARCHAR(64)  NOT NULL,
  `username`             VARCHAR(64)  NOT NULL,
  `session_key`     VARCHAR(128) NOT NULL,
  `source`          VARCHAR(32)  NOT NULL COMMENT 'web | cron | channel | api',
  `schedule_id`     VARCHAR(64)      NULL,
  `idempotency_key` VARCHAR(128)     NULL,
  `status`          VARCHAR(24)  NOT NULL COMMENT 'running|ok|error|timeout|aborted|needs_reauth',
  `model_id`        VARCHAR(128)     NULL,
  `error_code`      VARCHAR(64)      NULL,
  `error_message`   TEXT             NULL,
  `started_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ended_at`        DATETIME         NULL,
  PRIMARY KEY (`run_id`),
  UNIQUE KEY `uk_idempotency` (`idempotency_key`),
  KEY `idx_username_started` (`username`, `started_at` DESC),
  KEY `idx_schedule` (`schedule_id`, `started_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='云端 agent 任务台账';
