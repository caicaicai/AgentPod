-- 会话的项目归属、置顶、归档。
--
-- 这三列在 src/sessions/schema.sql 的 CREATE TABLE 里早就有了，所以**新库不需要
-- 这个文件**（跑到这里会撞 1060，被当成"已经是目标状态"）。它是给那些在这三个
-- 功能之前就建好表的老库补的。
--
-- 在此之前，这三条 ALTER 是以注释的形式躺在 schema.sql 里的 —— 而 splitStatements
-- 会主动滤掉注释行，也就是说它们从来没有被执行过，只是一段"请你手工去跑"的说明。
-- 这个目录存在的理由就是这个。

ALTER TABLE `ap_cloud_session` ADD COLUMN `project_id` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所属项目，空串=未归入任何项目';
ALTER TABLE `ap_cloud_session` ADD COLUMN `pinned`   TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `ap_cloud_session` ADD COLUMN `archived` TINYINT(1) NOT NULL DEFAULT 0;

-- 按项目列会话要走这条索引。老库上补列之后索引也得跟着补，
-- 否则项目页的会话列表是全表扫。
ALTER TABLE `ap_cloud_session` ADD KEY `idx_username_project` (`username`, `project_id`, `updated_at` DESC);
